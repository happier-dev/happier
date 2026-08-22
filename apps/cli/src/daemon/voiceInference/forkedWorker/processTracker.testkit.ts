import type { TerminationEvent } from '@/subprocess/supervision/types';

import type { ForkedVoiceInferenceWorkerProcessObservation } from './forkedRuntimeLoader';

/**
 * Test-only lifecycle evidence for the exact child reported by the canonical
 * forked-runtime observer. It deliberately has no ambient process discovery.
 */
export function createObservedForkedWorkerProcessTracker(): Readonly<{
  observe: (process: ForkedVoiceInferenceWorkerProcessObservation) => void;
  activePids: () => readonly number[];
  waitForNewPid: (excludedPids?: readonly number[], timeoutMs?: number) => Promise<number>;
  waitForTermination: (pid: number, timeoutMs?: number) => Promise<TerminationEvent>;
}> {
  const terminationsByPid = new Map<number, Promise<TerminationEvent>>();
  const activePids = new Set<number>();

  return {
    observe: (workerProcess) => {
      if (workerProcess.pid === null) {
        throw new Error('observed_forked_worker_pid_unavailable');
      }
      const pid = workerProcess.pid;
      const termination = workerProcess.waitForTermination().finally(() => {
        activePids.delete(pid);
      });
      terminationsByPid.set(pid, termination);
      activePids.add(pid);
    },
    activePids: () => [...activePids].sort((a, b) => a - b),
    waitForNewPid: async (excludedPids = [], timeoutMs = 10_000) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const candidates = [...activePids].filter((pid) => !excludedPids.includes(pid));
        if (candidates.length === 1) return candidates[0]!;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('observed_forked_worker_pid_not_observed');
    },
    waitForTermination: async (pid, timeoutMs = 3_000) => {
      const termination = terminationsByPid.get(pid);
      if (!termination) {
        throw new Error(`observed_forked_worker_pid_not_owned:${pid}`);
      }
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          termination,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`observed_forked_worker_did_not_exit:${pid}`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}
