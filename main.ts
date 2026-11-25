// Pump.fun Sharpe Sprint paper bot — entry point (agent-fun/replay/v2).
// The kit's harness runs `node /bot/main.ts` and speaks hello / batch /
// done over NDJSON stdin; the strategy in strategy.ts answers each batch
// with its orders, and the SDK shim in vendor/makefun-bot.ts is the kit's
// sdk/ts/makefun-bot.ts vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const bot = createStrategy(DEFAULT_PARAMS);
await runBot(bot);
