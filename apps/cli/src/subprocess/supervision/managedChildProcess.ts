/**
 * Managed wrapper around a Node ChildProcess.
 *
 * Ensures:
 * - termination events are normalized,
 * - waiters always settle (including non-zero exits),
 * - callers can request termination with a grace period (handled by a higher-level supervisor).
 */

import type { ChildProcess } from 'node:child_process';
import { logger } from '@/ui/logger';
import { observeProcessLaunch } from '@/processes/launchNotification';

import { classifyChildExit, classifySpawnError } from './exitClassifier';
import type { TerminationEvent } from './types';

export type ManagedChildProcess = Readonly<{
  pid: number | null;
  /**
   * Wait for failed process creation or physical subprocess exit.
   * Operation errors from a running child are not termination evidence.
   * This promise must always resolve exactly once.
   */
  waitForTermination: () => Promise<TerminationEvent>;
}>;

export function createManagedChildProcess(child: Pick<ChildProcess, 'pid' | 'on' | 'once'>): ManagedChildProcess {
  observeProcessLaunch(child);
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
  child.on('error', (error) => {
    if (pid === null) {
      resolveTermination(classifySpawnError(error));
    } else if (!settled) {
      logger.infoFile('[managedChildProcess] Child operation failed before physical exit', { pid });
    }
  });

  return {
    pid,
    waitForTermination: async () => termination,
  };
}

