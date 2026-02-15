import { describe, expect, it, vi } from 'vitest';

import type { DaemonState } from '@/api/types';
import { publishShutdownStateBestEffort } from './publishShutdownState';

describe('publishShutdownStateBestEffort', () => {
  it('does not block longer than timeout when update call hangs', async () => {
    vi.useFakeTimers();
    try {
      const updateDaemonState = vi.fn(() => new Promise<DaemonState>(() => {}));
      const shutdown = vi.fn();
      const warn = vi.fn();

      const promise = publishShutdownStateBestEffort({
        apiMachine: {
          updateDaemonState,
          shutdown,
        },
        source: 'happier-cli',
        timeoutMs: 250,
        warn,
      });

      await vi.advanceTimersByTimeAsync(260);
      await promise;

      expect(updateDaemonState).toHaveBeenCalledTimes(1);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded 250ms'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shuts down immediately when state update completes quickly', async () => {
    const updateDaemonState = vi.fn(async (updater: (state: DaemonState | null) => DaemonState) =>
      updater({ status: 'online' }),
    );
    const shutdown = vi.fn();
    const warn = vi.fn();

    await publishShutdownStateBestEffort({
      apiMachine: {
        updateDaemonState,
        shutdown,
      },
      source: 'happier-app',
      timeoutMs: 500,
      warn,
    });

    expect(updateDaemonState).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
