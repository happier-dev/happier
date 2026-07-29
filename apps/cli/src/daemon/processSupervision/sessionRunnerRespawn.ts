/**
 * Session runner respawn scheduling for the daemon.
 *
 * This is responsible for restarting session runner processes after unexpected termination,
 * while ensuring stop requests never trigger restart loops.
 */

import {
  SESSION_RUNNER_EXIT_CODES,
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import type { TrackedSession } from '@/daemon/types';

import {
  DEFAULT_INTENDED_RESTART_WINDOW_MS,
  RestartController,
} from '@/subprocess/supervision/restartController';
import type { StopRequest, TerminationEvent } from '@/subprocess/supervision/types';

export type DaemonChildExit = Readonly<{ reason: string; code: number | null; signal: string | null }>;
export type SessionRunnerRespawnDisposition = 'ignored' | 'scheduled' | 'terminal';

export type SessionRunnerRespawnManager = Readonly<{
  markStopRequested: (sessionId: string, request: StopRequest) => void;
  prepareFreshExplicitResumeAdmission: (sessionId: string) => () => void;
  handleUnexpectedExit: (
    trackedSession: TrackedSession,
    exit: DaemonChildExit,
    options?: Readonly<{
      forceRestart?: boolean;
      spawnOptionsOverride?: SpawnSessionOptions;
    }>,
  ) => SessionRunnerRespawnDisposition;
}>;

export type SessionRunnerRespawnOptionsResolver = (input: Readonly<{
  sessionId: string;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
}>) => SpawnSessionOptions | Promise<SpawnSessionOptions>;

export type SessionRunnerRespawnTerminalReason =
  | 'already_running'
  | 'continuation_unreachable'
  | 'directory_approval_required'
  | 'missing_spawn_options'
  | 'no_restart'
  | 'not_authenticated'
  | 'resume_not_supported'
  | 'startup_instructions_cold_resume_unproven'
  | 'stop_requested';

function normalizeSessionId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeOptionalString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isNotAuthenticatedSpawnResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as Readonly<{
    code?: unknown;
    error?: unknown;
    errorCode?: unknown;
    errorMessage?: unknown;
  }>;
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

function isResumeNotSupportedSpawnResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as Readonly<{ type?: unknown; errorCode?: unknown }>;
  return (
    value.type === 'error'
    && value.errorCode === SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED
  );
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

const connectedServiceRestartRequestedTerminationEvent: TerminationEvent = {
  type: 'spawn_error',
  errorName: 'ConnectedServiceRestartRequested',
  errorMessage: 'connected_service_auth_group_restart_requested',
};

// A runner webhook proves startup reached the session boundary, but not that the replacement
// process is stable. Keep the existing crash budget until the replacement survives this window.
const DEFAULT_RESPAWN_STABILITY_WINDOW_MS = 60_000;

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
  /** Own budget for intended (connected-service) restarts; see RestartController (RR-2). */
  maxIntendedRestarts?: number | null;
  /** Rolling window for intended-restart accounting across SUCCESSFUL cycles (RR-2 cross-cycle). */
  intendedRestartWindowMs?: number;
  /** Time a successful generic respawn must remain alive before its crash budget resets. */
  stabilityWindowMs?: number;
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
        ...(params.maxIntendedRestarts === undefined ? {} : {
          maxIntendedRestarts: params.maxIntendedRestarts,
        }),
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
    existing.timer = null;
  };

  const intendedRestartWindowMs = Math.max(
    0,
    Math.trunc(params.intendedRestartWindowMs ?? DEFAULT_INTENDED_RESTART_WINDOW_MS),
  );

  const armIntendedStateExpiry = (
    sessionId: string,
    existing: { controller: RestartController; timer: NodeJS.Timeout | null; intended: boolean },
  ) => {
    const timer = setTimeout(() => {
      const current = stateBySessionId.get(sessionId);
      if (current !== existing) return;
      current.timer = null;
      if (current.controller.hasRecentIntendedRestarts()) {
        armIntendedStateExpiry(sessionId, current);
        return;
      }
      stateBySessionId.delete(sessionId);
    }, intendedRestartWindowMs) as unknown as { unref?: () => void };
    timer.unref?.();
    existing.timer = timer as NodeJS.Timeout;
  };

  /**
   * Ends a terminal, intended-success, or proven-stable respawn cycle. Historically this deleted
   * the whole state, which also reset the intended-restart budget — so a storm of
   * SUCCESSFUL intended restarts (each restart succeeds, state resets, next restart begins; the
   * incident-#1 restart-loop shape) was unbounded across cycles. Intended-restart accounting lives
   * in the controller's rolling window, so while any intended restarts remain inside the window the
   * controller is RETAINED with only its crash budget reset (preserving the historical
   * fresh-crash-budget semantics); once the window decays empty the state is dropped as before.
   */
  const endRespawnCycle = (sessionId: string) => {
    const existing = stateBySessionId.get(sessionId);
    if (!existing) return;
    clearTimer(sessionId);
    if (existing.controller.hasRecentIntendedRestarts()) {
      existing.controller.resetCrashBudget();
      existing.intended = false;
      armIntendedStateExpiry(sessionId, existing);
      return;
    }
    stateBySessionId.delete(sessionId);
  };

  const observeRespawnSuccess = (sessionId: string) => {
    const existing = stateBySessionId.get(sessionId);
    if (!existing) return;

    if (existing.intended) {
      endRespawnCycle(sessionId);
      return;
    }

    clearTimer(sessionId);
    const stabilityWindowMs = Math.max(
      0,
      Math.trunc(params.stabilityWindowMs ?? DEFAULT_RESPAWN_STABILITY_WINDOW_MS),
    );
    const timer = setTimeout(() => {
      const current = stateBySessionId.get(sessionId);
      if (current !== existing) return;
      current.timer = null;
      endRespawnCycle(sessionId);
    }, stabilityWindowMs) as unknown as { unref?: () => void };
    timer.unref?.();
    existing.timer = timer as NodeJS.Timeout;
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

    scheduleSpawn(
      sessionId,
      spawnOptions,
      spawnOptions,
      vendorResumeId,
      decision.delayMs,
      decision.attempt,
      event,
      previousPid,
    );
  };

  const scheduleSpawn = (
    sessionId: string,
    spawnOptions: SpawnSessionOptions,
    retrySpawnOptions: SpawnSessionOptions,
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
        const finishIfStopRequested = (): boolean => {
          const stopRequest = stopRequestedBySessionId.get(sessionId);
          if (!stopRequest) return false;
          endRespawnCycle(sessionId);
          params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'stop_requested' });
          return true;
        };

        const alreadyRunning = await params.isSessionAlreadyRunning(sessionId);
        if (alreadyRunning) {
          endRespawnCycle(sessionId);
          params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'already_running' });
          return;
        }
        if (finishIfStopRequested()) return;

        // A snapshot resolver receives observed identity separately; do not relabel it as explicit Resume intent.
        const defaultVendorResumeId = params.resolveRespawnOptions ? '' : vendorResumeId;
        const defaultOptions = buildRespawnOptions({
          spawnOptions,
          sessionId,
          vendorResumeId: defaultVendorResumeId,
        });
        const respawnOptions = params.resolveRespawnOptions
          ? await params.resolveRespawnOptions({ sessionId, spawnOptions, vendorResumeId, defaultOptions })
          : defaultOptions;
        if (finishIfStopRequested()) return;

        params.logDebug(
          `[DAEMON RUN] Respawning runner for session ${sessionId} after ${delayMs}ms (attempt ${attempt})`,
          { exit: event },
        );

        void params
          .spawnSession(respawnOptions)
          .then((result) => {
            if (result && typeof result === 'object' && (result as any).type === 'success') {
              params.onRespawnSuccess?.({ sessionId, previousPid, result });
              observeRespawnSuccess(sessionId);
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

            if (isResumeNotSupportedSpawnResult(result)) {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (resume not supported)`);
              endRespawnCycle(sessionId);
              params.onRespawnTerminal?.({ sessionId, previousPid, reason: 'resume_not_supported' });
              return;
            }

            // The child exit handler resolves this result before its durable exit staging invokes
            // handleUnexpectedExit. That later notification is the single owner of the retry
            // decision, so consuming another decision here would double-count one process exit.
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
            scheduleRetryFromTermination(sessionId, retrySpawnOptions, vendorResumeId, retryEvent, previousPid);
          })
          .catch((error) => {
            params.logDebug(`[DAEMON RUN] Failed to respawn runner for session ${sessionId}`, error);
            const retryEvent: TerminationEvent = {
              type: 'spawn_error',
              errorName: error instanceof Error ? error.name : 'Error',
              errorMessage: error instanceof Error ? error.message : String(error),
            };
            scheduleRetryFromTermination(sessionId, retrySpawnOptions, vendorResumeId, retryEvent, previousPid);
          });
      })().catch((error) => {
        params.logDebug(`[DAEMON RUN] Failed to evaluate respawn preflight for session ${sessionId}`, error);
        const retryEvent: TerminationEvent = {
          type: 'spawn_error',
          errorName: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        scheduleRetryFromTermination(sessionId, retrySpawnOptions, vendorResumeId, retryEvent, previousPid);
      });
    }, delayMs) as unknown as { unref?: () => void };
    timer.unref?.();
    existing.timer = timer as any;
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
        stateBySessionId.delete(sessionId);
      }
    },
    prepareFreshExplicitResumeAdmission: (sessionIdRaw: string) => {
      const sessionId = normalizeSessionId(sessionIdRaw);
      const admittedStopRequest = sessionId
        ? stopRequestedBySessionId.get(sessionId) ?? null
        : null;
      return () => {
        if (!sessionId) return;
        const currentStopRequest = stopRequestedBySessionId.get(sessionId) ?? null;
        if (currentStopRequest !== admittedStopRequest) return;
        stopRequestedBySessionId.delete(sessionId);
        stateBySessionId.get(sessionId)?.controller.clearStopRequested();
      };
    },
    handleUnexpectedExit: (trackedSession: TrackedSession, exit: DaemonChildExit, options) => {
      if (!params.enabled && options?.forceRestart !== true) return 'ignored';
      if (trackedSession.startedBy !== 'daemon') return 'ignored';
      const sessionId = normalizeSessionId(trackedSession.happySessionId);
      if (!sessionId) return 'ignored';
      const forceRestart = options?.forceRestart === true;
      const stopRequest = stopRequestedBySessionId.get(sessionId);
      if (stopRequest) return 'ignored';

      if (exit.code === SESSION_RUNNER_EXIT_CODES.CONTINUATION_UNREACHABLE) {
        endRespawnCycle(sessionId);
        params.logWarn(
          `[DAEMON RUN] Respawn suppressed for session ${sessionId} (continuation unreachable)`,
        );
        params.onRespawnTerminal?.({
          sessionId,
          previousPid: trackedSession.pid,
          reason: 'continuation_unreachable',
        });
        return 'terminal';
      }

      const durableSpawnOptions = trackedSession.spawnOptions;
      const spawnOptions = options?.spawnOptionsOverride ?? durableSpawnOptions;
      if (
        !durableSpawnOptions
        || typeof (durableSpawnOptions as any).directory !== 'string'
        || !String((durableSpawnOptions as any).directory).trim()
        || !spawnOptions
        || typeof (spawnOptions as any).directory !== 'string'
        || !String((spawnOptions as any).directory).trim()
      ) {
        params.onRespawnTerminal?.({
          sessionId,
          previousPid: trackedSession.pid,
          reason: 'missing_spawn_options',
        });
        return 'terminal';
      }

      if (
        trackedSession.agentSessionStartupInstructionsMarkerV1
        || durableSpawnOptions.agentSessionStartupInstructionsV1
        || spawnOptions.agentSessionStartupInstructionsV1
      ) {
        endRespawnCycle(sessionId);
        params.logWarn(
          `[DAEMON RUN] Respawn suppressed for session ${sessionId} `
          + '(startup-instruction cold-resume effectiveness is unproven)',
        );
        params.onRespawnTerminal?.({
          sessionId,
          previousPid: trackedSession.pid,
          reason: 'startup_instructions_cold_resume_unproven',
        });
        return 'terminal';
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
        return 'terminal';
      }

      scheduleSpawn(
        sessionId,
        spawnOptions,
        durableSpawnOptions,
        vendorResumeId,
        forceRestart ? 0 : decision.delayMs,
        decision.attempt,
        event,
        trackedSession.pid,
      );
      return 'scheduled';
    },
  };
}
