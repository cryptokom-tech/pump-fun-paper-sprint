// Pump.fun Paper Sprint — entrypoint.
//
// Runs on Node 22 (the grader runs `node main.ts`; Node strips the types,
// so there is no build step and nothing to install). The wire protocol lives
// in vendor/makefun-bot.ts; the whole strategy lives in strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createPaperSprintBot } from './strategy.ts';

// The bot speaks agent-fun/replay/v2 on stdin/stdout: one reply per batch,
// no clock, no randomness, no network. A non-zero exit means the run failed.
await runBot(createPaperSprintBot());
