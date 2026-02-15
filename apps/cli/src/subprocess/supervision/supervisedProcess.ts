/**
 * High-level supervised process wrapper that can restart a process according to policy.
 *
 * This is intentionally generic: domain code supplies `spawn()` and receives termination callbacks.
 */

import { RestartController } from './restartController';
import type { ManagedProcessId, ManagedProcessPolicy, StopRequest, TerminationEvent } from './types';

type RestartScheduledInfo = Readonly<{
  attempt: number;
  delayMs: number;
  event: TerminationEvent;
}>;

export type SupervisedProcess = Readonly<{
  id: ManagedProcessId;
  markStopRequested: (request: StopRequest) => void;
  start: () => void;
  dispose: () => void;
}>;

type SpawnedInstance = Readonly<{
  pid: number | null;
  waitForTermination: () => Promise<TerminationEvent>;
}>;

type CreateSupervisedProcessParams = Readonly<{
  id: ManagedProcessId;
  policy: ManagedProcessPolicy;
  spawn: () => Promise<SpawnedInstance>;
  onTermination: (event: TerminationEvent) => void | Promise<void>;
  onRestartScheduled?: (info: RestartScheduledInfo) => void;
  loggerDebug?: (message: string, payload?: unknown) => void;
  random?: () => number;
}>;

export function createSupervisedProcess(params: CreateSupervisedProcessParams): SupervisedProcess {
  const random = params.random ?? Math.random;

  const restartController = new RestartController(params.policy.restart, { random });

  let disposed = false;
  let running = false;
  let pendingTimer: NodeJS.Timeout | null = null;

  const clearTimer = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const runOnce = async (): Promise<void> => {
    if (disposed) return;
    running = true;

    let terminationEvent: TerminationEvent;
    try {
      const instance = await params.spawn();
      terminationEvent = await instance.waitForTermination();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      terminationEvent = { type: 'spawn_error', errorName: 'Error', errorMessage: message };
    }

    if (disposed) return;

    try {
      await params.onTermination(terminationEvent);
    } catch (error) {
      params.loggerDebug?.(`[supervisedProcess] onTermination failed (non-fatal)`, error);
    }

    const decision = restartController.nextDecisionForTermination(terminationEvent);
    if (decision.type === 'no_restart') {
      running = false;
      return;
    }

    params.onRestartScheduled?.({ attempt: decision.attempt, delayMs: decision.delayMs, event: terminationEvent });
    clearTimer();
    pendingTimer = setTimeout(() => {
      void runOnce();
    }, decision.delayMs);
    pendingTimer.unref?.();
  };

  return {
    id: params.id,
    markStopRequested: (request: StopRequest) => {
      restartController.markStopRequested(request);
      clearTimer();
    },
    start: () => {
      if (disposed) return;
      if (running) return;
      void runOnce();
    },
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}
