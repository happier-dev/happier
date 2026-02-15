/**
 * Managed wrapper around a Node ChildProcess.
 *
 * Ensures:
 * - termination events are normalized,
 * - waiters always settle (including non-zero exits),
 * - callers can request termination with a grace period (handled by a higher-level supervisor).
 */

import type { ChildProcess } from 'node:child_process';

import { classifyChildExit, classifySpawnError } from './exitClassifier';
import type { TerminationEvent } from './types';

export type ManagedChildProcess = Readonly<{
  pid: number | null;
  /**
   * Wait for the subprocess to terminate for any reason.
   * This promise must always resolve exactly once.
   */
  waitForTermination: () => Promise<TerminationEvent>;
}>;

export function createManagedChildProcess(child: ChildProcess): ManagedChildProcess {
  const pid = typeof child.pid === 'number' && Number.isFinite(child.pid) ? child.pid : null;

  let settled = false;
  let resolveTermination: (e: TerminationEvent) => void;
  const termination = new Promise<TerminationEvent>((resolve) => {
    resolveTermination = (event) => {
      if (settled) return;
      settled = true;
      resolve(event);
    };
  });

  child.once('exit', (code, signal) => {
    resolveTermination(classifyChildExit({ code, signal: (signal as NodeJS.Signals | null) ?? null }));
  });
  child.once('error', (error) => {
    resolveTermination(classifySpawnError(error));
  });

  return {
    pid,
    waitForTermination: async () => termination,
  };
}

