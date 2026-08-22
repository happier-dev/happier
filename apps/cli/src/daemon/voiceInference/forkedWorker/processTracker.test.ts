import type { TerminationEvent } from '@/subprocess/supervision/types';
import { describe, expect, it } from 'vitest';

import { createObservedForkedWorkerProcessTracker } from './processTracker.testkit';

describe('observed forked worker process tracker', () => {
  it('tracks only the exact observed child and its termination', async () => {
    let resolveTermination!: (event: TerminationEvent) => void;
    const tracker = createObservedForkedWorkerProcessTracker();
    tracker.observe({
      pid: 42_001,
      waitForTermination: () => new Promise<TerminationEvent>((resolve) => {
        resolveTermination = resolve;
      }),
    });

    await expect(tracker.waitForNewPid()).resolves.toBe(42_001);
    expect(tracker.activePids()).toEqual([42_001]);

    resolveTermination({ type: 'signaled', signal: 'SIGKILL' });
    await expect(tracker.waitForTermination(42_001)).resolves.toEqual({
      type: 'signaled',
      signal: 'SIGKILL',
    });
    expect(tracker.activePids()).toEqual([]);
  });

  it('rejects lifecycle waits for a process it did not observe', async () => {
    const tracker = createObservedForkedWorkerProcessTracker();

    await expect(tracker.waitForTermination(42_002)).rejects.toThrow(
      'observed_forked_worker_pid_not_owned:42002',
    );
  });
});
