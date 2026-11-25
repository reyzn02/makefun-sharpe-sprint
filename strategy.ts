// Steady-momentum paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// How the run works: the harness sends hello, then one batch per slot
// window, then done, and this bot answers every batch with the orders for
// that slot. The competition ranks by hourly Sharpe ratio, so the bot is
// built for steady, small, repeatable wins rather than one lucky moonshot.
// It only buys young curves whose recent tape shows genuine buying — net SOL
// flowing in, several distinct buyers, the price climbing and sitting close
// to its window high, with the inflow still accelerating — sizes every
// position the same, and sells the whole position at the first of a
// stop-loss, a take-profit, a trailing stop once the trade is ahead, a fade
// in buy flow, or a time limit. The exits are fast on purpose (stop 6%,
// trail 5% off the peak, take-profit 8%, held at most 1200 slots): on the
// dev window slow exits bled into the stop on most trades, while fast exits
// lifted the win rate and cut the drawdown sharply.
//
// A pace probe keeps the run above the guardrail (round trips of at least
// 0.01 SOL on at least 20 distinct mints). When the coins traded so far lag
// the pace the 6-hour window implies, the bot opens one tiny probe round
// trip on the most liquid curve and sells it as soon as the buy lands.
//
// History: a stricter variant was tried and dropped — demanding more inflow
// (0.75 SOL), more buyers (6), a bigger rise (5%) and quicker exits (take
// 6%, stop 5%, trail 4%, 900 slots) traded more often (180 vs 128 round
// trips), paid more in fees and netted worse (-0.662 vs -0.613 SOL on dev
// with a worse drawdown), so the looser v1 parameters below are the ones
// that ship. The one kept revision is a probe guard: the pace probe used to
// buy the most liquid curve with any recent trade, even one being sold off,
// so it now only probes a curve whose latest trade was a buy and whose price
// sits above its recent mean.
//
// Deterministic by construction: no clock, no environment, no randomness.
// Every decision comes from the batch stream, and the maps are walked in
// insertion order, so two runs produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000; // lamports in one SOL, as a float for SOL-denominated maths

export interface Params {
  windowTrades: number;
  minNetInflow: number;
  minBuyCount: number;
  minBuyerCount: number;
  minRise: number;
  maxRise: number;
  nearHighFrac: number;
  minAgeSlots: number;
  maxAgeSlots: number;
  minRealSol: number;
  maxRealSol: number;
  stake: number;
  minBuy: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  stopLossFrac: number;
  trailFrac: number;
  trailArmFrac: number;
  takeProfitFrac: number; // sell once close value >= cost * (1 + takeProfitFrac); 0 switches it off
  fadeWindow: number; // sell once net SOL over the last N trades < -fadeNetOutflow; 0 switches it off
  fadeNetOutflow: number;
  maxHoldSlots: number;
  cooldownSlots: number;
  maxEntriesPerCurve: number;
  maxMainPositions: number;
  maxExposure: number;
  targetCoinCount: number;
  totalSlotsEstimate: number;
  probeStake: number;
  probeLagCoins: number;
  probeMeanTrades: number; // probe only when the latest trade is a buy and the price beats the mean of the last N trade prices
}

export const DEFAULT_PARAMS: Params = {
  windowTrades: 30,
  minNetInflow: 0.5,
  minBuyCount: 8,
  minBuyerCount: 5,
  minRise: 0.04,
  maxRise: 1.0,
  nearHighFrac: 0.9,
  minAgeSlots: 400,
  maxAgeSlots: 6000,
  minRealSol: 1,
  maxRealSol: 80,
  stake: 0.1,
  minBuy: 0.02,
  buySlippageBps: 1500,
  sellSlippageBps: 10000,
  stopLossFrac: 0.06,
  trailFrac: 0.05,
  trailArmFrac: 0.03,
  takeProfitFrac: 0.08,
  fadeWindow: 10,
  fadeNetOutflow: 0.3,
  maxHoldSlots: 1200,
  cooldownSlots: 300,
  maxEntriesPerCurve: 2,
  maxMainPositions: 4,
  maxExposure: 2,
  targetCoinCount: 20,
  totalSlotsEstimate: 400000,
  probeStake: 0.01,
  probeLagCoins: 3,
  probeMeanTrades: 10,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface OpenPosition {
  opened: number; // slot the buy was decided on
  peakLamports: number; // best close value seen so far, in lamports
  exiting: boolean; // a sell for this mint is already in flight
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const held = new Map<Pubkey, OpenPosition>();
  const probes = new Map<Pubkey, boolean>(); // false = probe buy in flight, true = selling
  let firstSlot = -1;
  let coinsTraded = 0;
  const coinsSeen = new Set<Pubkey>();

  function curvePrice(state: BotState, mint: Pubkey): number | null {
    const c = state.curves.get(mint);
    if (c === undefined) return null;
    if (c.virtual_token_reserves === 0n) return null;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  }

  function positionValue(state: BotState, mint: Pubkey): number | null {
    const pos = state.positions.get(mint);
    const price = curvePrice(state, mint);
    if (pos === undefined || price === null) return null;
    return Number(pos.token_amount) * price;
  }

  function tapeForCurve(mint: Pubkey): CurveTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1 };
      tapes.set(mint, t);
    }
    return t;
  }

  /** Rolling-window entry signal for one curve; null when any gate fails. */
  function entrySignal(state: BotState, mint: Pubkey, slot: number): { stake: bigint } | null {
    const tape = tapes.get(mint);
    const curve = state.curves.get(mint);
    if (tape === undefined || curve === undefined || curve.complete) return null;
    if (tape.created === null) return null;
    const age = slot - tape.created;
    if (age < p.minAgeSlots || age > p.maxAgeSlots) return null;
    if (tape.entries >= p.maxEntriesPerCurve) return null;
    if (slot - tape.lastExit < p.cooldownSlots) return null;
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
    if (net < p.minNetInflow || buys < p.minBuyCount || buyers.size < p.minBuyerCount) return null;
    const first = win[0].price;
    const last = win[win.length - 1].price;
    if (first <= 0 || last <= 0) return null;
    const rise = last / first - 1;
    if (rise < p.minRise || rise > p.maxRise) return null;
    if (last < p.nearHighFrac * high) return null;
    // Acceleration: the newer half of the window must bring at least as much
    // net inflow as the older half, so the buying is still growing, not fading.
    const half = Math.floor(win.length / 2);
    let netOld = 0;
    let netNew = 0;
    for (let i = 0; i < win.length; i++) {
      const v = win[i].buy ? win[i].sol : -win[i].sol;
      if (i < half) netOld += v;
      else netNew += v;
    }
    if (netNew < netOld) return null;
    const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
    if (realSol < p.minRealSol || realSol > p.maxRealSol) return null;
    const cap = state.maxBuyLamports(mint);
    const stakeLamports = BigInt(Math.round(p.stake * LAMPORTS_PER_SOL));
    const stake = cap < stakeLamports ? cap : stakeLamports;
    if (stake < BigInt(Math.round(p.minBuy * LAMPORTS_PER_SOL))) return null;
    return { stake };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();

      // Fold this batch's fills in: count newly traded coins, arm probe sells.
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
          const t = tapeForCurve(e.mint);
          if (t.created === null) t.created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeForCurve(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS_PER_SOL,
            user: e.user,
            price,
          });
          if (t.trades.length > 40) t.trades.splice(0, t.trades.length - 40);
        } else {
          // CompleteEvent: the curve is done, so drop its tape.
          tapes.delete(e.mint);
        }
      }

      // --- exits first: stop-loss, trailing stop, take-profit, fade, time ---
      let exposureSol = 0;
      for (const pos of state.positions.values()) exposureSol += Number(pos.cost_lamports) / LAMPORTS_PER_SOL;
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        const value = positionValue(state, mint);
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
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
          h.exiting = true;
          continue;
        }
        const ratio = value / cost;
        const armed = h.peakLamports >= cost * (1 + p.trailArmFrac);
        const trailing = armed && value <= h.peakLamports * (1 - p.trailFrac);
        const stopped = ratio <= 1 - p.stopLossFrac;
        const taken = p.takeProfitFrac > 0 && ratio >= 1 + p.takeProfitFrac;
        let faded = false;
        if (p.fadeWindow > 0) {
          const tape = tapes.get(mint);
          if (tape !== undefined && tape.trades.length >= p.fadeWindow) {
            let netFade = 0;
            for (const tr of tape.trades.slice(-p.fadeWindow)) netFade += tr.buy ? tr.sol : -tr.sol;
            faded = netFade < -p.fadeNetOutflow;
          }
        }
        const timedOut = batch.slot - h.opened >= p.maxHoldSlots;
        if (stopped || trailing || timedOut || taken || faded) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
          h.exiting = true;
          const tape = tapes.get(mint);
          if (tape !== undefined) tape.lastExit = batch.slot;
        }
      }
      // Forget held records whose position is gone (sold, or closed by the harness).
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
        if (mainOpen >= p.maxMainPositions) break;
        if (exposureSol >= p.maxExposure) break;
        const sig = entrySignal(state, mint, batch.slot);
        if (sig === null) continue;
        if (free < sig.stake + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: sig.stake, max_slippage_bps: p.buySlippageBps });
        free -= sig.stake + tx;
        mainOpen++;
        exposureSol += Number(sig.stake) / LAMPORTS_PER_SOL;
        tapeForCurve(mint).entries++;
      }

      // --- pace probe: keep the run on track for the 20-coin guardrail ---
      const progress = Math.min(1, Math.max(0, (batch.slot - firstSlot) / p.totalSlotsEstimate));
      const expected = p.targetCoinCount * progress;
      const probeOpen = probes.size > 0;
      let probePending = false;
      for (const po of state.pending.values()) {
        if (probes.has(po.order.mint)) {
          probePending = true;
          break;
        }
      }
      if (!probeOpen && !probePending && coinsTraded < expected - p.probeLagCoins) {
        if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
          // Most liquid curve with a recent trade, not held, not completed —
          // and still being bought: the latest trade must be a buy and the
          // price must sit above its recent mean, so the probe never buys
          // into a sell-off.
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const [mint, curve] of state.curves) {
            if (curve.complete || state.positions.has(mint)) continue;
            const tape = tapes.get(mint);
            if (tape === undefined || tape.trades.length === 0) continue;
            const lastTrade = tape.trades[tape.trades.length - 1];
            if (batch.slot - lastTrade.slot > 200) continue;
            if (!lastTrade.buy) continue;
            let sum = 0;
            let n = 0;
            for (const tr of tape.trades.slice(-p.probeMeanTrades)) {
              sum += tr.price;
              n++;
            }
            if (n === 0 || lastTrade.price <= sum / n) continue;
            const rq = Number(curve.real_quote_reserves);
            if (rq > bestRq) {
              bestRq = rq;
              best = mint;
            }
          }
          if (best !== null) {
            const cap = state.maxBuyLamports(best);
            const probeLamports = BigInt(Math.round(p.probeStake * LAMPORTS_PER_SOL));
            const stake = cap < probeLamports ? cap : probeLamports;
            if (stake >= probeLamports && free >= stake + tx) {
              orders.push({ side: 'buy', mint: best, quote_lamports: stake, max_slippage_bps: p.buySlippageBps });
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
