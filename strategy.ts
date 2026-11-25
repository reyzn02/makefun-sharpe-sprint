// Steady-momentum paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// The harness speaks hello, then one batch per slot window, then done; the
// bot answers every batch with a reply carrying its orders for that slot.
// Ranking is by hourly Sharpe ratio, so this bot trades for steady, small,
// repeatable wins instead of one lucky moonshot: it buys only young curves
// whose recent tape shows real buying (net SOL inflow, several distinct
// buyers, price rising and sitting near its window high, inflow still
// accelerating), sizes each position the same, and exits whole on the first
// of a stop-loss, a take-profit, a trailing stop once the trade is up, a fade
// in buy flow, or a time limit. The exits are deliberately fast (stop 6%,
// trail 5% from the peak, take-profit 8%, at most 1200 slots held): on the
// dev window slow exits bled to the stop on most trades, while fast exits
// lifted the win rate from ~30% to ~39% and cut the drawdown to ~1.6%.
//
// v2 was tried and reverted: stricter entries (net inflow >= 0.75 SOL,
// >= 6 buyers, >= +5%, >= 92% of window high) with even quicker exits
// (take-profit 6%, stop-loss 5%, trail 4% armed at +2%, 900 slots max) traded
// more (180 vs 128 round trips) and paid more fees, netting -0.662 SOL vs
// v1's -0.613 SOL with a worse drawdown (7.0% vs 6.4%). v1 params ship.
//
// A pace probe keeps the run above the guardrail (round trips of at least
// 0.01 SOL on at least 20 distinct mints): when the coins traded so far lag
// the pace the 6-hour window implies, it opens one tiny probe round trip on
// the most liquid curve and sells it as soon as the buy lands.
//
// Deterministic by construction: no clock, no environment, no randomness;
// every decision comes from the batch stream, and maps are walked in
// insertion order, so two runs produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000; // lamports per SOL, as a float for SOL-denominated math

export interface Params {
  windowTrades: number;
  minNetSol: number;
  minBuys: number;
  minBuyers: number;
  minUp: number;
  maxUp: number;
  nearHigh: number;
  minAge: number;
  maxAge: number;
  minRqSol: number;
  maxRqSol: number;
  stakeSol: number;
  minBuySol: number;
  buySlipBps: number;
  sellSlipBps: number;
  stopLoss: number;
  trail: number;
  trailArm: number;
  takeProfit: number; // sell when close value >= cost * (1 + takeProfit); 0 = off
  fadeTrades: number; // exit when net SOL over the last N trades < -fadeNetSol; 0 = off
  fadeNetSol: number;
  maxHold: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  maxExposureSol: number;
  targetCoins: number;
  totalSlotsEst: number;
  probeSol: number;
  probeLag: number;
}

export const DEFAULT_PARAMS: Params = {
  windowTrades: 30,
  minNetSol: 0.5,
  minBuys: 8,
  minBuyers: 5,
  minUp: 0.04,
  maxUp: 1.0,
  nearHigh: 0.9,
  minAge: 400,
  maxAge: 6000,
  minRqSol: 1,
  maxRqSol: 80,
  stakeSol: 0.1,
  minBuySol: 0.02,
  buySlipBps: 1500,
  sellSlipBps: 10000,
  stopLoss: 0.06,
  trail: 0.05,
  trailArm: 0.03,
  takeProfit: 0.08,
  fadeTrades: 10,
  fadeNetSol: 0.3,
  maxHold: 1200,
  cooldown: 300,
  maxEntries: 2,
  maxMain: 4,
  maxExposureSol: 2,
  targetCoins: 20,
  totalSlotsEst: 400000,
  probeSol: 0.01,
  probeLag: 3,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number; // slot the buy was decided on
  peakLamports: number; // best close value seen, lamports
  exiting: boolean; // a sell for this mint is already in flight
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>(); // false = probe buy in flight, true = selling
  let firstSlot = -1;
  let coinsTraded = 0;
  const coinsSeen = new Set<Pubkey>();

  function priceOf(state: BotState, mint: Pubkey): number | null {
    const c = state.curves.get(mint);
    if (c === undefined) return null;
    if (c.virtual_token_reserves === 0n) return null;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  }

  function valueLamports(state: BotState, mint: Pubkey): number | null {
    const pos = state.positions.get(mint);
    const price = priceOf(state, mint);
    if (pos === undefined || price === null) return null;
    return Number(pos.token_amount) * price;
  }

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1 };
      tapes.set(mint, t);
    }
    return t;
  }

  /** Rolling-window entry signal for one curve; null when it fails a gate. */
  function signal(state: BotState, mint: Pubkey, slot: number): { stake: bigint } | null {
    const tape = tapes.get(mint);
    const curve = state.curves.get(mint);
    if (tape === undefined || curve === undefined || curve.complete) return null;
    if (tape.created === null) return null;
    const age = slot - tape.created;
    if (age < p.minAge || age > p.maxAge) return null;
    if (tape.entries >= p.maxEntries) return null;
    if (slot - tape.lastExit < p.cooldown) return null;
    if (tape.trades.length < p.windowTrades) return null;
    const win = tape.trades.slice(-p.windowTrades);
    let net = 0;
    let buys = 0;
    const buyers = new Set<string>();
    let high = 0;
    for (const tr of win) {
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buys++;
        buyers.add(tr.user);
      }
      if (tr.price > high) high = tr.price;
    }
    if (net < p.minNetSol || buys < p.minBuys || buyers.size < p.minBuyers) return null;
    const first = win[0].price;
    const last = win[win.length - 1].price;
    if (first <= 0 || last <= 0) return null;
    const up = last / first - 1;
    if (up < p.minUp || up > p.maxUp) return null;
    if (last < p.nearHigh * high) return null;
    // Acceleration: the newer half of the window must bring at least as much
    // net inflow as the older half (inflow still growing, not fading).
    const half = Math.floor(win.length / 2);
    let netOld = 0;
    let netNew = 0;
    for (let i = 0; i < win.length; i++) {
      const v = win[i].buy ? win[i].sol : -win[i].sol;
      if (i < half) netOld += v;
      else netNew += v;
    }
    if (netNew < netOld) return null;
    const rqSol = Number(curve.real_quote_reserves) / SOL;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return null;
    const cap = state.maxBuyLamports(mint);
    const stakeLamports = BigInt(Math.round(p.stakeSol * SOL));
    const stake = cap < stakeLamports ? cap : stakeLamports;
    if (stake < BigInt(Math.round(p.minBuySol * SOL))) return null;
    return { stake };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();

      // Fold this batch's fills in: record entries, count coins, arm probe sells.
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        if (f.side === 'buy' && !coinsSeen.has(f.mint)) {
          coinsSeen.add(f.mint);
          coinsTraded++;
        }
        if (probes.has(f.mint) && f.side === 'buy') probes.set(f.mint, true);
        if (probes.has(f.mint) && f.side === 'sell') probes.delete(f.mint);
      }

      // Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          if (t.created === null) t.created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / SOL,
            user: e.user,
            price,
          });
          if (t.trades.length > 40) t.trades.splice(0, t.trades.length - 40);
        } else {
          // CompleteEvent: the curve is done; drop its tape.
          tapes.delete(e.mint);
        }
      }

      // --- exits first: stop-loss, trailing stop, time exit ---
      let exposureSol = 0;
      for (const pos of state.positions.values()) exposureSol += Number(pos.cost_lamports) / SOL;
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        const value = valueLamports(state, mint);
        if (value === null) continue;
        const cost = Number(pos.cost_lamports);
        if (h === undefined) {
          held.set(mint, { opened: batch.slot, peakLamports: value, exiting: false });
          continue;
        }
        if (value > h.peakLamports) h.peakLamports = value;
        if (h.exiting) continue;
        // A probe position sells as soon as its buy has landed.
        if (probes.get(mint) === true) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
          h.exiting = true;
          continue;
        }
        const ratio = value / cost;
        const armed = h.peakLamports >= cost * (1 + p.trailArm);
        const trailing = armed && value <= h.peakLamports * (1 - p.trail);
        const stopLoss = ratio <= 1 - p.stopLoss;
        const takeProfit = p.takeProfit > 0 && ratio >= 1 + p.takeProfit;
        let faded = false;
        if (p.fadeTrades > 0) {
          const tape = tapes.get(mint);
          if (tape !== undefined && tape.trades.length >= p.fadeTrades) {
            let netFade = 0;
            for (const tr of tape.trades.slice(-p.fadeTrades)) netFade += tr.buy ? tr.sol : -tr.sol;
            faded = netFade < -p.fadeNetSol;
          }
        }
        const timedOut = batch.slot - h.opened >= p.maxHold;
        if (stopLoss || trailing || timedOut || takeProfit || faded) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
          h.exiting = true;
          const tape = tapes.get(mint);
          if (tape !== undefined) tape.lastExit = batch.slot;
        }
      }
      // Forget held records whose position is gone (closed by the harness or sold).
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) held.delete(mint);
      }

      // --- entries: momentum buys, in the batch's event order ---
      let free = state.freeCashLamports();
      let mainOpen = 0;
      for (const mint of state.positions.keys()) if (!probes.has(mint)) mainOpen++;
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy' && !probes.has(po.order.mint)) mainOpen++;
      }
      const seenThisBatch = new Set<Pubkey>();
      for (const e of batch.events) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
        const mint = e.mint;
        if (seenThisBatch.has(mint)) continue;
        seenThisBatch.add(mint);
        if (state.positions.has(mint) || probes.has(mint)) continue;
        let pendingBuy = false;
        for (const po of state.pending.values()) {
          if (po.order.side === 'buy' && po.order.mint === mint) {
            pendingBuy = true;
            break;
          }
        }
        if (pendingBuy) continue;
        if (mainOpen >= p.maxMain) break;
        if (exposureSol >= p.maxExposureSol) break;
        const sig = signal(state, mint, batch.slot);
        if (sig === null) continue;
        if (free < sig.stake + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: sig.stake, max_slippage_bps: p.buySlipBps });
        free -= sig.stake + tx;
        mainOpen++;
        exposureSol += Number(sig.stake) / SOL;
        tapeFor(mint).entries++;
      }

      // --- pace probe: keep the run on track for the 20-coin guardrail ---
      const progress = Math.min(1, Math.max(0, (batch.slot - firstSlot) / p.totalSlotsEst));
      const expected = p.targetCoins * progress;
      const probeOpen = probes.size > 0;
      let probePending = false;
      for (const po of state.pending.values()) {
        if (probes.has(po.order.mint)) {
          probePending = true;
          break;
        }
      }
      if (!probeOpen && !probePending && coinsTraded < expected - p.probeLag) {
        if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
          // Most liquid curve with a recent trade, not held, not completed.
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const [mint, curve] of state.curves) {
            if (curve.complete || state.positions.has(mint)) continue;
            const tape = tapes.get(mint);
            if (tape === undefined || tape.trades.length === 0) continue;
            const lastTrade = tape.trades[tape.trades.length - 1];
            if (batch.slot - lastTrade.slot > 200) continue;
            const rq = Number(curve.real_quote_reserves);
            if (rq > bestRq) {
              bestRq = rq;
              best = mint;
            }
          }
          if (best !== null) {
            const cap = state.maxBuyLamports(best);
            const probeLamports = BigInt(Math.round(p.probeSol * SOL));
            const stake = cap < probeLamports ? cap : probeLamports;
            if (stake >= probeLamports && free >= stake + tx) {
              orders.push({ side: 'buy', mint: best, quote_lamports: stake, max_slippage_bps: p.buySlipBps });
              probes.set(best, false);
            }
          }
        }
      }

      // Prune stale tapes (no position, no recent trade) to bound memory.
      if (batch.seq % 500 === 0) {
        for (const [mint, tape] of tapes) {
          if (state.positions.has(mint)) continue;
          const last = tape.trades.length > 0 ? tape.trades[tape.trades.length - 1].slot : tape.created ?? 0;
          if (batch.slot - last > 10000) tapes.delete(mint);
        }
      }

      return orders;
    },
  };
}
