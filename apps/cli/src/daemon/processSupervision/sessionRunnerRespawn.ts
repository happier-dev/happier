/**
 * Session runner respawn scheduling for the daemon.
 *
 * This is responsible for restarting session runner processes after unexpected termination,
 * while ensuring stop requests never trigger restart loops.
 */

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '@/daemon/types';
import {
  SPAWN_SESSION_ERROR_CODES,
  isConnectedServiceResumeUnreachableSpawnErrorDetail,
} from '@happier-dev/protocol';

import { RestartController } from '@/subprocess/supervision/restartController';
import type { StopRequest, TerminationEvent } from '@/subprocess/supervision/types';

export type DaemonChildExit = Readonly<{ reason: string; code: number | null; signal: string | null }>;

export type SessionRunnerRespawnManager = Readonly<{
  markStopRequested: (sessionId: string, request: StopRequest) => void;
  clearStopRequested: (sessionId: string) => void;
  handleUnexpectedExit: (
    trackedSession: TrackedSession,
    exit: DaemonChildExit,
    options?: Readonly<{ forceRestart?: boolean }>,
  ) => void;
}>;

export type SessionRunnerRespawnOptionsResolver = (input: Readonly<{
  sessionId: string;
  previousPid: number;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
}>) => SpawnSessionOptions | Promise<SpawnSessionOptions>;

export type SessionRunnerRespawnTerminalReason =
  | 'already_running'
  | 'stop_requested'
  | 'missing_spawn_options'
  | 'directory_approval_required'
  | 'not_authenticated'
  | 'resume_unreachable'
  | 'no_restart';

function normalizeSessionId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeOptionalString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isNotAuthenticatedSpawnResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as { code?: unknown; error?: unknown; errorCode?: unknown; errorMessage?: unknown };
  return (
    value.code === 'not_authenticated' ||
    value.error === 'not_authenticated' ||
    value.errorCode === 'not_authenticated' ||
    value.errorMessage === 'not_authenticated'
  );
}

function isChildExitedBeforeWebhookSpawnResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as Readonly<{ type?: unknown; errorCode?: unknown }>;
  return (
    value.type === 'error'
    && value.errorCode === SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK
  );
}

function isResumeUnreachableSpawnResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as { errorDetail?: unknown };
  return isConnectedServiceResumeUnreachableSpawnErrorDetail(value.errorDetail);
}

function toTerminationEvent(exit: DaemonChildExit): TerminationEvent {
  if (typeof exit.signal === 'string' && exit.signal.trim().length > 0) {
    return { type: 'signaled', signal: exit.signal as NodeJS.Signals };
  }
  if (typeof exit.code === 'number' && Number.isFinite(exit.code)) {
    return { type: 'exited', code: Math.max(0, Math.trunc(exit.code)) };
  }
  if (exit.reason === 'process-missing' || exit.reason === 'process-reused') return { type: 'missing' };
  if (exit.reason === 'process-error') {
    return { type: 'spawn_error', errorName: 'Error', errorMessage: 'process-error' };
  }
  return { type: 'exited', code: 1 };
}

const connectedServiceRestartRequestedTerminationEvent: TerminationEvent = {
  type: 'spawn_error',
  errorName: 'ConnectedServiceRestartRequested',
  errorMessage: 'connected_service_auth_group_restart_requested',
};

function resolveRespawnKind(event: TerminationEvent): 'connected_service_intended_restart' | 'respawn_retry' {
  return event.type === 'spawn_error'
    && event.errorName === 'ConnectedServiceRestartRequested'
    && event.errorMessage === 'connected_service_auth_group_restart_requested'
    ? 'connected_service_intended_restart'
    : 'respawn_retry';
}

function buildRespawnOptions(params: Readonly<{
  spawnOptions: SpawnSessionOptions;
  sessionId: string;
  vendorResumeId: string;
}>): SpawnSessionOptions {
  const resumeFromOptions = normalizeOptionalString(params.spawnOptions.resume);
  const resumeFromTracked = normalizeOptionalString(params.vendorResumeId);
  const effectiveResume = resumeFromOptions || resumeFromTracked;
  const { resume: _resume, ...spawnOptionsWithoutResume } = params.spawnOptions;
  return {
    ...spawnOptionsWithoutResume,
    ...(effectiveResume ? { resume: effectiveResume } : {}),
    existingSessionId: params.sessionId,
    sessionId: undefined,
    approvedNewDirectoryCreation: true,
  };
}

export function createSessionRunnerRespawnManager(params: Readonly<{
  enabled: boolean;
  maxRestarts: number | null;
  /**
   * Own budget for INTENDED connected-service restarts, kept separate from `maxRestarts` so a forced
   * relaunch never consumes the generic crash-loop counter (RR-2). Left undefined the controller uses
   * its bounded default.
   */
  maxIntendedRestarts?: number | null;
  /**
   * Rolling window for intended-restart accounting. Intended restarts inside the window count
   * against `maxIntendedRestarts` even across SUCCESSFUL respawns, so a successful restart loop is
   * still bounded; occasional restarts spread over time decay out.
   */
  intendedRestartWindowMs?: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  isSessionAlreadyRunning: (sessionId: string) => boolean | Promise<boolean>;
  spawnSession: (opts: SpawnSessionOptions) => Promise<unknown>;
  resolveRespawnOptions?: SessionRunnerRespawnOptionsResolver;
  onRespawnSuccess?: (input: Readonly<{
    sessionId: string;
    previousPid: number;
    result: unknown;
  }>) => void;
  onRespawnTerminal?: (input: Readonly<{
    sessionId: string;
    previousPid: number;
    reason: SessionRunnerRespawnTerminalReason;
    detail?: string;
  }>) => void;
  random: () => number;
  logDebug: (message: string, payload?: unknown) => void;
  logWarn: (message: string) => void;
}>): SessionRunnerRespawnManager {
  const stopRequestedBySessionId = new Map<string, StopRequest>();
  const stateBySessionId = new Map<
    string,
    { controller: RestartController; timer: NodeJS.Timeout | null; intended: boolean }
  >();

  const getOrCreateController = (sessionId: string): RestartController => {
    const existing = stateBySessionId.get(sessionId);
    if (existing) return existing.controller;

    const controller = new RestartController(
      {
        mode: 'on_unexpected_exit',
        maxRestarts: params.maxRestarts,
        maxIntendedRestarts: params.maxIntendedRestarts,
        ...(params.intendedRestartWindowMs === undefined ? {} : {
          intendedRestartWindowMs: params.intendedRestartWindowMs,
        }),
        baseDelayMs: params.baseDelayMs,
        maxDelayMs: params.maxDelayMs,
        jitterMs: params.jitterMs,
      },
      { random: params.random },
    );

    const stopRequest = stopRequestedBySessionId.get(sessionId);
    if (stopRequest) controller.markStopRequested(stopRequest);

    stateBySessionId.set(sessionId, { controller, timer: null, intended: false });
    return controller;
  };

  /**
   * A restart cycle that began as an INTENDED connected-service relaunch stays on the intended
   * budget for every retry within that cycle, so the whole storm (initial + retries) is bounded by
   * its OWN limiter and never leaks into the generic crash budget (RR-2). A genuine crash exit runs
   * the generic termination decision.
   */
  const decideRestartForCycle = (
    sessionId: string,
    controller: RestartController,
    event: TerminationEvent,
  ): ReturnType<RestartController['nextDecisionForTermination']> => {
    return stateBySessionId.get(sessionId)?.intended === true
      ? controller.nextDecisionForIntendedRestart()
      : controller.nextDecisionForTermination(event);
  };

  const clearTimer = (sessionId: string) => {
    const existing = stateBySessionId.get(sessionId);
    if (!existing?.timer) return;
    clearTimeout(existing.timer);
    stateBySessionId.set(sessionId, { ...existing, timer: null });
  };

  /**
   * Ends a respawn cycle (success or terminal outcome). Historically this deleted the whole state,
   * which also reset the intended-restart budget — so a storm of SUCCESSFUL intended restarts
   * (each restart succeeds, state resets, next restart begins; the incident-#1 restart-loop shape)
   * was unbounded across cycles. Intended-restart accounting lives in the controller's rolling
   * window, so while any intended restarts remain inside the window the controller is RETAINED with
   * only its crash budget reset (preserving the historical fresh-crash-budget semantics); once the
   * window decays empty the state is dropped as before.
   */
  const endRespawnCycle = (sessionId: string) => {
    const existing = stateBySessionId.get(sessionId);
    if (!existing) return;
    if (existing.controller.hasRecentIntendedRestarts()) {
      existing.controller.resetCrashBudget();
      existing.intended = false;
      existing.timer = null;
      return;
    }
    stateBySessionId.delete(sessionId);
  };

  const scheduleRetryFromTermination = (
    sessionId: string,
    spawnOptions: SpawnSessionOptions,
    vendorResumeId: string,
    event: TerminationEvent,
    previousPid: number,
  ) => {
    const state = stateBySessionId.get(sessionId);
    if (!state) return;

    const decision = decideRestartForCycle(sessionId, state.controller, event);
    if (decision.type === 'no_restart') {
      if (decision.reason.startsWith('max_restarts_exceeded') || decision.reason.startsWith('max_intended_restarts_exceeded')) {
        params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
      }
      endRespawnCycle(sessionId);
      params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'no_restart', detail: decision.reason });
      return;
    }

    scheduleSpawn(sessionId, spawnOptions, vendorResumeId, decision.delayMs, decision.attempt, event, previousPid);
  };

  const scheduleSpawn = (
    sessionId: string,
    spawnOptions: SpawnSessionOptions,
    vendorResumeId: string,
    delayMs: number,
    attempt: number,
    event: TerminationEvent,
    previousPid: number,
  ) => {
    clearTimer(sessionId);
    const existing = stateBySessionId.get(sessionId);
    if (!existing) return;

    const timer = setTimeout(() => {
      void (async () => {
        const alreadyRunning = await params.isSessionAlreadyRunning(sessionId);
        if (alreadyRunning) {
          endRespawnCycle(sessionId);
          params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'already_running' });
          return;
        }
        const stopRequest = stopRequestedBySessionId.get(sessionId);
        if (stopRequest) {
          endRespawnCycle(sessionId);
          params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'stop_requested' });
          return;
        }

        const defaultOptions = buildRespawnOptions({ spawnOptions, sessionId, vendorResumeId });
        const respawnOptions = params.resolveRespawnOptions
          ? await params.resolveRespawnOptions({ sessionId, previousPid, spawnOptions, vendorResumeId, defaultOptions })
          : defaultOptions;
        params.logDebug(
          `[DAEMON RUN] Respawning runner for session ${sessionId} after ${delayMs}ms (attempt ${attempt})`,
          { exit: event, attempt, respawnKind: resolveRespawnKind(event) },
        );

        void params
          .spawnSession(respawnOptions)
          .then((result) => {
            if (result && typeof result === 'object' && (result as any).type === 'success') {
              params.onRespawnSuccess?.({ sessionId, previousPid, result });
              // Cycle end, NOT a full reset: the intended-restart window must survive a successful
              // respawn or a "successful" intended-restart loop is unbounded across cycles (RR-2).
              endRespawnCycle(sessionId);
              return;
            }

            if (result && typeof result === 'object' && (result as any).type === 'requestToApproveDirectoryCreation') {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (directory approval required)`);
              endRespawnCycle(sessionId);
              params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'directory_approval_required' });
              return;
            }

            if (isNotAuthenticatedSpawnResult(result)) {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (auth:not_authenticated)`);
              endRespawnCycle(sessionId);
              params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'not_authenticated' });
              return;
            }

            if (isResumeUnreachableSpawnResult(result)) {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (resume unreachable)`);
              endRespawnCycle(sessionId);
              params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'resume_unreachable' });
              return;
            }

            // The child-exit handler resolves this result before durable exit staging invokes
            // handleUnexpectedExit. That staged notification is the single retry owner for the
            // replacement process, so retrying here as well launches competing replacements.
            if (isChildExitedBeforeWebhookSpawnResult(result)) {
              params.logDebug(
                `[DAEMON RUN] Respawn child exited before webhook for session ${sessionId}; awaiting staged exit notification`,
                result,
              );
              return;
            }

            params.logDebug(`[DAEMON RUN] Respawn attempt returned non-success for session ${sessionId}`, result);
            const retryEvent: TerminationEvent = {
              type: 'spawn_error',
              errorName: 'Error',
              errorMessage:
                result && typeof result === 'object' && typeof (result as any).errorCode === 'string'
                  ? `respawn_failed:${String((result as any).errorCode)}`
                  : 'respawn_failed',
            };
            scheduleRetryFromTermination(sessionId, spawnOptions, vendorResumeId, retryEvent, previousPid);
          })
          .catch((error) => {
            params.logDebug(`[DAEMON RUN] Failed to respawn runner for session ${sessionId}`, error);
            const retryEvent: TerminationEvent = {
              type: 'spawn_error',
              errorName: error instanceof Error ? error.name : 'Error',
              errorMessage: error instanceof Error ? error.message : String(error),
            };
            scheduleRetryFromTermination(sessionId, spawnOptions, vendorResumeId, retryEvent, previousPid);
          });
      })().catch((error) => {
        params.logDebug(`[DAEMON RUN] Failed to evaluate respawn preflight for session ${sessionId}`, error);
        const retryEvent: TerminationEvent = {
          type: 'spawn_error',
          errorName: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        scheduleRetryFromTermination(sessionId, spawnOptions, vendorResumeId, retryEvent, previousPid);
      });
    }, delayMs) as unknown as { unref?: () => void };
    timer.unref?.();
    stateBySessionId.set(sessionId, { ...existing, timer: timer as any });
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
    handleUnexpectedExit: (trackedSession: TrackedSession, exit: DaemonChildExit, options) => {
      if (!params.enabled && options?.forceRestart !== true) return;
      if (trackedSession.startedBy !== 'daemon') return;
      const sessionId = normalizeSessionId(trackedSession.happySessionId);
      if (!sessionId) return;
      const forceRestart = options?.forceRestart === true;
      if (forceRestart) {
        // A connected-service-initiated forced restart explicitly supersedes any prior stop request
        // (e.g. a stale flag left by an earlier manual stop that the resume path never cleared --
        // `clearStopRequested` has no production caller). Without this, the forced kill's respawn is
        // silently vetoed and the session dies, surfaced to the user as an exit-143 crash. Clearing
        // here makes the manager map, a freshly-created controller, and the scheduled-spawn re-check
        // all treat this as the intentional restart it is.
        stopRequestedBySessionId.delete(sessionId);
        stateBySessionId.get(sessionId)?.controller.clearStopRequested();
      }
      const stopRequest = stopRequestedBySessionId.get(sessionId);
      if (stopRequest) return;

      const spawnOptions = trackedSession.spawnOptions;
      if (!spawnOptions || typeof (spawnOptions as any).directory !== 'string' || !String((spawnOptions as any).directory).trim()) {
        if (forceRestart) {
          params.onRespawnTerminal?.({ sessionId, previousPid: trackedSession.pid, reason: 'missing_spawn_options' });
        }
        return;
      }

      const vendorResumeId = normalizeOptionalString(trackedSession.vendorResumeId);
      const controller = getOrCreateController(sessionId);
      if (forceRestart) {
        // Mark this as an intended (connected-service-initiated) restart cycle so its whole storm —
        // the initial relaunch plus any retries — runs on the intended budget, never the generic
        // crash counter (RR-2).
        const state = stateBySessionId.get(sessionId);
        if (state) state.intended = true;
      }
      const event = forceRestart ? connectedServiceRestartRequestedTerminationEvent : toTerminationEvent(exit);
      const decision = decideRestartForCycle(sessionId, controller, event);
      if (decision.type === 'no_restart') {
        if (decision.reason.startsWith('max_restarts_exceeded') || decision.reason.startsWith('max_intended_restarts_exceeded')) {
          params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
        }
        endRespawnCycle(sessionId);
        params.onRespawnTerminal?.({
          sessionId,
          previousPid: trackedSession.pid,
          reason: 'no_restart',
          detail: decision.reason,
        });
        return;
      }

      scheduleSpawn(
        sessionId,
        spawnOptions,
        vendorResumeId,
        forceRestart ? 0 : decision.delayMs,
        decision.attempt,
        event,
        trackedSession.pid,
      );
    },
  };
}
