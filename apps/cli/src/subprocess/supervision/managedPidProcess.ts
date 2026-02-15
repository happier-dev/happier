/**
 * Managed wrapper around a PID-only process (no ChildProcess handle).
 *
 * This is used for tmux/visible-console/reattached session runners where the daemon only knows a PID.
 */

import type { TerminationEvent } from './types';

export type ManagedPidProcess = Readonly<{
  pid: number;
  /**
   * Wait for the PID to disappear (polling). When the pid disappears, the termination event is `missing`.
   */
  waitForTermination: () => Promise<TerminationEvent>;
}>;

export function createManagedPidProcess(params: Readonly<{
  pid: number;
  pollIntervalMs: number;
  isAlive: (pid: number) => boolean;
}>): ManagedPidProcess {
  const pid = Math.trunc(params.pid);
  const pollIntervalMs = Math.max(10, Math.trunc(params.pollIntervalMs));

  const waitForTermination = async (): Promise<TerminationEvent> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!params.isAlive(pid)) return { type: 'missing' };
      await new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, pollIntervalMs) as unknown as { unref?: () => void };
        handle.unref?.();
      });
    }
  };

  return { pid, waitForTermination };
}

