/**
 * Session runner respawn scheduling for the daemon.
 *
 * This is responsible for restarting session runner processes after unexpected termination,
 * while ensuring stop requests never trigger restart loops.
 */

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '@/daemon/types';

import { RestartController } from '@/subprocess/supervision/restartController';
import type { StopRequest, TerminationEvent } from '@/subprocess/supervision/types';

export type DaemonChildExit = Readonly<{ reason: string; code: number | null; signal: string | null }>;

export type SessionRunnerRespawnManager = Readonly<{
  markStopRequested: (sessionId: string, request: StopRequest) => void;
  clearStopRequested: (sessionId: string) => void;
  handleUnexpectedExit: (trackedSession: TrackedSession, exit: DaemonChildExit) => void;
}>;

function normalizeSessionId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function toTerminationEvent(exit: DaemonChildExit): TerminationEvent {
  if (typeof exit.signal === 'string' && exit.signal.trim().length > 0) {
    return { type: 'signaled', signal: exit.signal as NodeJS.Signals };
  }
  if (typeof exit.code === 'number' && Number.isFinite(exit.code)) {
    return { type: 'exited', code: Math.max(0, Math.trunc(exit.code)) };
  }
  if (exit.reason === 'process-missing') return { type: 'missing' };
  if (exit.reason === 'process-error') {
    return { type: 'spawn_error', errorName: 'Error', errorMessage: 'process-error' };
  }
  return { type: 'exited', code: 1 };
}

function buildRespawnOptions(params: Readonly<{ spawnOptions: SpawnSessionOptions; sessionId: string }>): SpawnSessionOptions {
  return {
    ...params.spawnOptions,
    existingSessionId: params.sessionId,
    sessionId: undefined,
    initialPrompt: undefined,
    resume: undefined,
    approvedNewDirectoryCreation: true,
  };
}

export function createSessionRunnerRespawnManager(params: Readonly<{
  enabled: boolean;
  maxRestarts: number | null;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  isSessionAlreadyRunning: (sessionId: string) => boolean;
  spawnSession: (opts: SpawnSessionOptions) => Promise<unknown>;
  random: () => number;
  logDebug: (message: string, payload?: unknown) => void;
  logWarn: (message: string) => void;
}>): SessionRunnerRespawnManager {
  const stopRequestedBySessionId = new Map<string, StopRequest>();
  const stateBySessionId = new Map<
    string,
    Readonly<{ controller: RestartController; timer: NodeJS.Timeout | null }>
  >();

  const getOrCreateController = (sessionId: string): RestartController => {
    const existing = stateBySessionId.get(sessionId);
    if (existing) return existing.controller;

    const controller = new RestartController(
      {
        mode: 'on_unexpected_exit',
        maxRestarts: params.maxRestarts,
        baseDelayMs: params.baseDelayMs,
        maxDelayMs: params.maxDelayMs,
        jitterMs: params.jitterMs,
      },
      { random: params.random },
    );

    const stopRequest = stopRequestedBySessionId.get(sessionId);
    if (stopRequest) controller.markStopRequested(stopRequest);

    stateBySessionId.set(sessionId, { controller, timer: null });
    return controller;
  };

  const clearTimer = (sessionId: string) => {
    const existing = stateBySessionId.get(sessionId);
    if (!existing?.timer) return;
    clearTimeout(existing.timer);
    stateBySessionId.set(sessionId, { controller: existing.controller, timer: null });
  };

  const scheduleSpawn = (sessionId: string, spawnOptions: SpawnSessionOptions, delayMs: number, attempt: number, event: TerminationEvent) => {
    clearTimer(sessionId);
    const existing = stateBySessionId.get(sessionId);
    if (!existing) return;

    const timer = setTimeout(() => {
      if (params.isSessionAlreadyRunning(sessionId)) return;
      const stopRequest = stopRequestedBySessionId.get(sessionId);
      if (stopRequest) return;

      const respawnOptions = buildRespawnOptions({ spawnOptions, sessionId });
      params.logDebug(
        `[DAEMON RUN] Respawning runner for session ${sessionId} after ${delayMs}ms (attempt ${attempt})`,
        { exit: event },
      );

      void params
        .spawnSession(respawnOptions)
        .then((result) => {
          if (result && typeof result === 'object' && (result as any).type === 'success') {
            stateBySessionId.delete(sessionId);
            return;
          }

          if (result && typeof result === 'object' && (result as any).type === 'requestToApproveDirectoryCreation') {
            params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (directory approval required)`);
            stateBySessionId.delete(sessionId);
            return;
          }

          params.logDebug(`[DAEMON RUN] Respawn attempt returned non-success for session ${sessionId}`, result);
          const state = stateBySessionId.get(sessionId);
          if (!state) return;

          const retryEvent: TerminationEvent = {
            type: 'spawn_error',
            errorName: 'Error',
            errorMessage:
              result && typeof result === 'object' && typeof (result as any).errorCode === 'string'
                ? `respawn_failed:${String((result as any).errorCode)}`
                : 'respawn_failed',
          };

          const decision = state.controller.nextDecisionForTermination(retryEvent);
          if (decision.type === 'no_restart') {
            if (decision.reason.startsWith('max_restarts_exceeded')) {
              params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
            }
            stateBySessionId.delete(sessionId);
            return;
          }

          scheduleSpawn(sessionId, spawnOptions, decision.delayMs, decision.attempt, retryEvent);
        })
        .catch((error) => {
          params.logDebug(`[DAEMON RUN] Failed to respawn runner for session ${sessionId}`, error);
          const state = stateBySessionId.get(sessionId);
          if (!state) return;

          const retryEvent: TerminationEvent = {
            type: 'spawn_error',
            errorName: error instanceof Error ? error.name : 'Error',
            errorMessage: error instanceof Error ? error.message : String(error),
          };
          const decision = state.controller.nextDecisionForTermination(retryEvent);
          if (decision.type === 'no_restart') {
            if (decision.reason.startsWith('max_restarts_exceeded')) {
              params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
            }
            stateBySessionId.delete(sessionId);
            return;
          }
          scheduleSpawn(sessionId, spawnOptions, decision.delayMs, decision.attempt, retryEvent);
        });
    }, delayMs) as unknown as { unref?: () => void };
    timer.unref?.();
    stateBySessionId.set(sessionId, { controller: existing.controller, timer: timer as any });
  };

  return {
    markStopRequested: (sessionIdRaw: string, request: StopRequest) => {
      const sessionId = normalizeSessionId(sessionIdRaw);
      if (!sessionId) return;
      stopRequestedBySessionId.set(sessionId, request);
      const existing = stateBySessionId.get(sessionId);
      if (existing) {
        existing.controller.markStopRequested(request);
        clearTimer(sessionId);
      }
    },
    clearStopRequested: (sessionIdRaw: string) => {
      const sessionId = normalizeSessionId(sessionIdRaw);
      if (!sessionId) return;
      stopRequestedBySessionId.delete(sessionId);
      const existing = stateBySessionId.get(sessionId);
      if (existing) {
        existing.controller.clearStopRequested();
      }
    },
    handleUnexpectedExit: (trackedSession: TrackedSession, exit: DaemonChildExit) => {
      if (!params.enabled) return;
      const sessionId = normalizeSessionId(trackedSession.happySessionId);
      if (!sessionId) return;
      const stopRequest = stopRequestedBySessionId.get(sessionId);
      if (stopRequest) return;

      const spawnOptions = trackedSession.spawnOptions;
      if (!spawnOptions || typeof (spawnOptions as any).directory !== 'string' || !String((spawnOptions as any).directory).trim()) {
        return;
      }

      const controller = getOrCreateController(sessionId);
      const event = toTerminationEvent(exit);
      const decision = controller.nextDecisionForTermination(event);
      if (decision.type === 'no_restart') {
        if (decision.reason.startsWith('max_restarts_exceeded')) {
          params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
        }
        stateBySessionId.delete(sessionId);
        return;
      }

      scheduleSpawn(sessionId, spawnOptions, decision.delayMs, decision.attempt, event);
    },
  };
}
