import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSupervisedProcess } from '../supervisedProcess';
import type { ManagedProcessPolicy, TerminationEvent } from '../types';

describe('createSupervisedProcess unhandled rejection safety', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not surface onRestartScheduled errors as unhandled promise rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const policy: ManagedProcessPolicy = {
      kind: 'other',
      restart: {
        mode: 'on_unexpected_exit',
        maxRestarts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitterMs: 0,
      },
      logging: { logTerminationEvents: false },
      artifacts: { captureStderr: false },
      terminateGraceMs: 1,
    };

    let spawned = 0;
    const termination: TerminationEvent = { type: 'exited', code: 1 };
    const supervisor = createSupervisedProcess({
      id: 'test',
      policy,
      spawn: async () => {
        spawned += 1;
        return { pid: 123, waitForTermination: async () => termination };
      },
      onTermination: async () => {},
      onRestartScheduled: () => {
        throw new Error('boom');
      },
    });

    try {
      supervisor.start();
      // Allow Node to emit the process-level unhandledRejection event if the
      // fire-and-forget task rejects.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(spawned).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      supervisor.dispose();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
