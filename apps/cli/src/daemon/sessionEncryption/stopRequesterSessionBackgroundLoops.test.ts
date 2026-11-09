import { expect, it, vi } from 'vitest';

import { startSingleFlightIntervalLoop } from '../lifecycle/singleFlightIntervalLoop';
import { stopRequesterSessionBackgroundLoops } from './stopRequesterSessionBackgroundLoops';

it('retires the last requester from its own observation without joining that observation', async () => {
  const testLifetime = new AbortController();
  const cleanup = new Promise<void>(resolve => testLifetime.signal.addEventListener('abort', () => resolve(), { once: true }));
  let retired = false;
  let taskSignal: AbortSignal | undefined;
  let starts = 0;
  let retirement: Promise<void> | undefined;
  let otherSignal: AbortSignal | undefined;
  const otherLoop = startSingleFlightIntervalLoop({ intervalMs: 60_000,
    task: signal => { otherSignal = signal; return cleanup; } });
  const loop = startSingleFlightIntervalLoop({
    intervalMs: 60_000,
    task: async signal => {
      starts++;
      taskSignal = signal;
      // Real refresh application has already crossed asynchronous acquisition
      // before releasing its requester; the loop owns this task by then.
      await Promise.resolve();
      // A committed refresh applies through withSessionAccountContext. Its
      // final release can retire this same now-unretained requester.
      retirement = Promise.resolve(stopRequesterSessionBackgroundLoops({ loops: [loop, otherLoop], onError: () => {} }));
      await Promise.race([retirement, cleanup]);
      retired = true;
    },
  });
  try {
    otherLoop.trigger();
    loop.trigger();
    await vi.waitFor(() => expect(retired, 'requester retirement waited on its own loop task').toBe(true));
    expect(taskSignal?.aborted).toBe(true);
    expect(otherSignal?.aborted).toBe(true);
    loop.trigger();
    await Promise.resolve();
    expect(starts).toBe(1);
  } finally {
    // Only the test observer has this escape so a valid RED cannot leak work.
    testLifetime.abort();
    await Promise.all([loop.stop(), otherLoop.stop()]);
    await retirement;
  }
});
