/**
 * Session runner respawn scheduling for the daemon.
 *
 * This is responsible for restarting session runner processes after unexpected termination,
 * while ensuring stop requests never trigger restart loops.
 */

import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
  SESSION_RUNNER_EXIT_CODES,
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import type { TrackedSession } from '@/daemon/types';
import { DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_CODE } from '@/mcp/pluginToolCatalogError';

import {
  DEFAULT_INTENDED_RESTART_WINDOW_MS,
  RestartController,
} from '@/subprocess/supervision/restartController';
import type { StopRequest, TerminationEvent } from '@/subprocess/supervision/types';

export type DaemonChildExit = Readonly<{ reason: string; code: number | null; signal: string | null }>;
export type SessionRunnerRespawnDisposition = 'ignored' | 'scheduled' | 'terminal';

export type SessionRunnerRespawnManager = Readonly<{
  hasPendingTerminalSettlements(): boolean;
  awaitTerminalSettlement(sessionId?: string): Promise<void>;
  hasPendingIntendedRestarts: (sessionId?: string) => boolean;
  markStopRequested: (sessionId: string, request: StopRequest) => void;
  prepareAutomaticResumeAdmission: (sessionId: string) => () => boolean;
  prepareFreshExplicitResumeAdmission: (sessionId: string) => Readonly<{
    isCurrent: () => boolean;
    retireIncumbent: (request: StopRequest) => void;
    complete: () => void;
  }>;
  handleUnexpectedExit: (
    trackedSession: TrackedSession,
    exit: DaemonChildExit,
    options?: Readonly<{
      forceRestart?: boolean;
      restartReason?: string;
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
  | 'session_directory_missing'
  | 'startup_dependency_failure'
  | 'startup_operation_failed'
  | 'startup_instructions_cold_resume_unproven'
  | 'terminal_follow_admission_failed'
  | 'stop_requested';

function normalizeSessionId(raw: unknown): string {
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

// A runner webhook proves startup reached the session boundary, but not that the replacement
// process is stable. Keep the existing crash budget until the replacement survives this window.
const DEFAULT_RESPAWN_STABILITY_WINDOW_MS = 60_000;

function buildRespawnOptions(params: Readonly<{
  spawnOptions: SpawnSessionOptions;
  sessionId: string;
  vendorResumeId: string;
}>): SpawnSessionOptions {
  // A resume id is the Agent's own opaque session identity. Respawn hands these
  // bytes straight back to it, so only presence is decided here.
  const resumeFromOptions = readNonBlankOpaqueIdentifier(params.spawnOptions.resume);
  const resumeFromTracked = readNonBlankOpaqueIdentifier(params.vendorResumeId);
  const effectiveResume = resumeFromOptions || resumeFromTracked;
  const { resume: _resume, freshSessionCreation: _freshSessionCreation, managedDirectorySeed: _managedDirectorySeed,
    spawnActionContext: _spawnActionContext, ...spawnOptionsWithoutResume } = params.spawnOptions;
  return {
    ...spawnOptionsWithoutResume,
    ...(effectiveResume ? { resume: effectiveResume } : {}),
    existingSessionId: params.sessionId,
    sessionId: undefined,
    approvedNewDirectoryCreation: params.spawnOptions.directoryKind !== 'managed',
  };
}

/**
 * Startup instructions are a first-start effect. Until their cold-resume
 * semantics are proven, every restart caller must leave the live runner in
 * place instead of discovering this only after process exit.
 */
export function isSessionRunnerColdResumeSupported(input: Readonly<{
  trackedSession: TrackedSession;
  spawnOptionsOverride?: SpawnSessionOptions;
}>): boolean {
  const durableSpawnOptions = input.trackedSession.spawnOptions;
  const spawnOptions =
    input.spawnOptionsOverride ?? durableSpawnOptions;
  return !(
    input.trackedSession.agentSessionStartupInstructionsMarkerV1
    || durableSpawnOptions?.agentSessionStartupInstructionsV1
    || spawnOptions?.agentSessionStartupInstructionsV1
  );
}

/** Home evidence must belong to this runner occurrence before it can end startup recovery. */
export function isCurrentDefiniteSessionStartupFailure(
  issue: SessionRuntimeIssueV1 | null | undefined,
  processStartTimeMs: number | undefined,
  runnerExitCode?: number | null,
): issue is SessionRuntimeIssueV1 {
  return issue?.scope === 'primary_session' && issue.status === 'failed'
    && (issue.source === 'dependency_failure'
      // Exit 78 is the host's required continuation refusal before native open.
      // A generic Session error alone must not terminalize retained input.
      || runnerExitCode === SESSION_RUNNER_EXIT_CODES.CONTINUATION_UNREACHABLE
        && issue.source === 'agent_session_error')
    && issue.code !== 'preparation_pending'
    && issue.code !== DAEMON_PLUGIN_TOOL_CATALOG_UNAVAILABLE_CODE
    && typeof processStartTimeMs === 'number' && Number.isFinite(processStartTimeMs)
    && issue.occurredAt >= processStartTimeMs;
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
  readStartupFailure?: (input: Readonly<{ sessionId: string; trackedSession: TrackedSession; runnerExitCode?: number | null }>) => Promise<SessionRuntimeIssueV1 | null>;
  spawnSession: (opts: SpawnSessionOptions, predecessor: Readonly<{ sessionId: string; previousPid: number; trackedSession: TrackedSession; intended: boolean }>) => Promise<unknown>;
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
  }>) => void | Promise<void>;
  onStopRequested?: (sessionId: string) => void;
  onTerminalSettlementChanged?: () => void;
  random: () => number;
  logDebug: (message: string, payload?: unknown) => void;
  logWarn: (message: string) => void;
}>): SessionRunnerRespawnManager {
  const stopRequestedBySessionId = new Map<string, { request: StopRequest; active: boolean }>();
  const readActiveStopRequest = (sessionId: string) => {
    const stop = stopRequestedBySessionId.get(sessionId);
    return stop?.active ? stop.request : undefined;
  };
  type TerminalSettlement = { previousPid: number; completion: Promise<void>; status: 'pending' | 'failed' };
  type RespawnState = { controller: RestartController; timer: NodeJS.Timeout | null; intended: boolean;
    retire?: () => void; terminalSettlement?: TerminalSettlement };
  const stateBySessionId = new Map<string, RespawnState>();

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

    const stopRequest = readActiveStopRequest(sessionId);
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
    delete existing.retire;
    if (existing.controller.hasRecentIntendedRestarts()) {
      existing.controller.resetCrashBudget();
      existing.intended = false;
      armIntendedStateExpiry(sessionId, existing);
      return;
    }
    stateBySessionId.delete(sessionId);
  };

  // Terminal effects belong to the existing supervisor until their asynchronous
  // publisher/removal completes. A rejection retains custody for the next real
  // exit/recovery trigger; it is neither a completed removal nor a timed retry.
  const beginTerminalSettlement = (input: Parameters<NonNullable<typeof params.onRespawnTerminal>>[0], before?: () => Promise<void>): Promise<void> => {
    getOrCreateController(input.sessionId);
    clearTimer(input.sessionId);
    const state = stateBySessionId.get(input.sessionId)!;
    const previous = state.terminalSettlement;
    if (previous?.previousPid === input.previousPid && previous.status === 'pending') return previous.completion;
    let invoked: void | Promise<void>;
    try { invoked = before ? before().then(() => params.onRespawnTerminal?.(input)) : params.onRespawnTerminal?.(input); }
    catch (error) { invoked = Promise.reject(error); }
    const terminal: TerminalSettlement = { previousPid: input.previousPid, completion: Promise.resolve(invoked), status: 'pending' };
    state.terminalSettlement = terminal;
    terminal.completion = terminal.completion.then(() => {
      if (stateBySessionId.get(input.sessionId) !== state || state.terminalSettlement !== terminal) return;
      delete state.terminalSettlement;
      endRespawnCycle(input.sessionId);
      params.onTerminalSettlementChanged?.();
    }, (error: unknown) => { terminal.status = 'failed'; params.onTerminalSettlementChanged?.(); throw error; });
    params.onTerminalSettlementChanged?.();
    terminal.completion.catch(error => params.logDebug('[DAEMON RUN] Terminal Session cleanup remains pending', {
      sessionId: input.sessionId, previousPid: input.previousPid, ...readUnexpectedActionErrorDiagnosticV1(error),
    }));
    return terminal.completion;
  };

  const observeRespawnSuccess = (sessionId: string) => {
    const existing = stateBySessionId.get(sessionId);
    if (!existing) return;
    delete existing.retire;

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
    trackedSession: TrackedSession,
  ) => {
    const previousPid = trackedSession.pid;
    const state = stateBySessionId.get(sessionId);
    if (!state) return;

    const decision = decideRestartForCycle(sessionId, state.controller, event);
    if (decision.type === 'no_restart') {
      if (decision.reason.startsWith('max_restarts_exceeded') || decision.reason.startsWith('max_intended_restarts_exceeded')) {
        params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
      }
      endRespawnCycle(sessionId);
      beginTerminalSettlement({ sessionId, previousPid, reason: 'no_restart', detail: decision.reason });
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
      trackedSession,
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
    trackedSession: TrackedSession,
  ) => {
    const previousPid = trackedSession.pid;
    clearTimer(sessionId);
    const existing = stateBySessionId.get(sessionId);
    if (!existing) return;

    let stopRetirementReported = false;
    const reportStopRetirement = () => {
      if (stopRetirementReported) return;
      stopRetirementReported = true;
      beginTerminalSettlement({ sessionId, previousPid, reason: 'stop_requested' });
    };
    existing.retire = reportStopRetirement;
    const timer = setTimeout(() => {
      void (async () => {
        const finishIfCycleRetired = (): boolean => {
          const stopRequest = readActiveStopRequest(sessionId);
          // Explicit Resume can clear Stop while an old Home read is still pending.
          // Clearing that intent does not revive the retired supervision cycle.
          if (!stopRequest) return stateBySessionId.get(sessionId) !== existing;
          if (stateBySessionId.get(sessionId) === existing) endRespawnCycle(sessionId);
          reportStopRetirement();
          return true;
        };

        const alreadyRunning = await params.isSessionAlreadyRunning(sessionId);
        if (finishIfCycleRetired()) return;
        if (alreadyRunning) {
          endRespawnCycle(sessionId);
          beginTerminalSettlement({ sessionId, previousPid, reason: 'already_running' });
          return;
        }
        const issue = await params.readStartupFailure?.({ sessionId, trackedSession });
        if (finishIfCycleRetired()) return;
        const processStartTimeMs = trackedSession.processStartTimeMs;
        // Home retains the host's typed failure. An older occurrence's issue must not
        // veto a fresh explicit Resume or a later runner's ordinary crash recovery.
        if (isCurrentDefiniteSessionStartupFailure(issue, processStartTimeMs)) {
          endRespawnCycle(sessionId);
          params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (startup dependency: ${issue.code})`);
          beginTerminalSettlement({ sessionId, previousPid, reason: 'startup_dependency_failure', detail: issue.code });
          return;
        }

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
        if (finishIfCycleRetired()) return;

        params.logDebug(
          `[DAEMON RUN] Respawning runner for session ${sessionId} after ${delayMs}ms (attempt ${attempt})`,
          { exit: event },
        );

        void params
          .spawnSession({
            ...respawnOptions,
            beforeSessionRunnerLaunch: async () => {
              // Launch preparation can outlive Stop. Keep the existing cycle's
              // custody through the physical launch, including an awaited caller hook.
              if (finishIfCycleRetired()) return false;
              if (respawnOptions.beforeSessionRunnerLaunch
                && !await respawnOptions.beforeSessionRunnerLaunch()) return false;
              return !finishIfCycleRetired();
            },
          }, { sessionId, previousPid, trackedSession, intended: existing.intended })
          .then((result) => {
            if (finishIfCycleRetired()) return;
            if (result && typeof result === 'object'
              && 'errorCode' in result
              && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING) {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (private directory missing)`);
              endRespawnCycle(sessionId);
              beginTerminalSettlement({ sessionId, previousPid, reason: 'session_directory_missing' });
              return;
            }
            if (result && typeof result === 'object' && (result as any).type === 'success') {
              params.onRespawnSuccess?.({ sessionId, previousPid, result });
              observeRespawnSuccess(sessionId);
              return;
            }

            if (result && typeof result === 'object' && (result as any).type === 'requestToApproveDirectoryCreation') {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (directory approval required)`);
              endRespawnCycle(sessionId);
              beginTerminalSettlement({ sessionId, previousPid, reason: 'directory_approval_required' });
              return;
            }

            if (isNotAuthenticatedSpawnResult(result)) {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (auth:not_authenticated)`);
              endRespawnCycle(sessionId);
              beginTerminalSettlement({ sessionId, previousPid, reason: 'not_authenticated' });
              return;
            }

            if (isResumeNotSupportedSpawnResult(result)) {
              params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (resume not supported)`);
              endRespawnCycle(sessionId);
              beginTerminalSettlement({ sessionId, previousPid, reason: 'resume_not_supported' });
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
            scheduleRetryFromTermination(sessionId, retrySpawnOptions, vendorResumeId, retryEvent, trackedSession);
          })
          .catch((error) => {
            if (finishIfCycleRetired()) return;
            params.logDebug(`[DAEMON RUN] Failed to respawn runner for session ${sessionId}`, error);
            const retryEvent: TerminationEvent = {
              type: 'spawn_error',
              errorName: error instanceof Error ? error.name : 'Error',
              errorMessage: error instanceof Error ? error.message : String(error),
            };
            scheduleRetryFromTermination(sessionId, retrySpawnOptions, vendorResumeId, retryEvent, trackedSession);
          });
      })().catch((error) => {
        if (stateBySessionId.get(sessionId) !== existing) return;
        params.logDebug(`[DAEMON RUN] Failed to evaluate respawn preflight for session ${sessionId}`, error);
        const retryEvent: TerminationEvent = {
          type: 'spawn_error',
          errorName: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        scheduleRetryFromTermination(sessionId, retrySpawnOptions, vendorResumeId, retryEvent, trackedSession);
      });
    }, delayMs) as unknown as { unref?: () => void };
    timer.unref?.();
    existing.timer = timer as any;
  };

  const markStopRequested = (sessionIdRaw: string, request: StopRequest) => {
    const sessionId = normalizeSessionId(sessionIdRaw);
    if (!sessionId) return;
    stopRequestedBySessionId.set(sessionId, { request, active: true });
    const existing = stateBySessionId.get(sessionId);
    if (existing) {
      existing.controller.markStopRequested(request);
      clearTimer(sessionId);
      if (!existing.terminalSettlement) stateBySessionId.delete(sessionId);
      existing.retire?.();
    }
    params.onStopRequested?.(sessionId);
  };

  return {
    hasPendingTerminalSettlements: () => {
      for (const state of stateBySessionId.values()) if (state.terminalSettlement) return true;
      return false;
    },
    async awaitTerminalSettlement(sessionId) {
      const completions = (sessionId === undefined ? [...stateBySessionId.values()] : [stateBySessionId.get(normalizeSessionId(sessionId))])
        .flatMap(state => state?.terminalSettlement ? [state.terminalSettlement.completion] : []);
      const settled = await Promise.allSettled(completions);
      const failure = settled.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
    hasPendingIntendedRestarts: (sessionId) => {
      if (sessionId !== undefined) return stateBySessionId.get(normalizeSessionId(sessionId))?.intended === true;
      for (const state of stateBySessionId.values()) if (state.intended) return true;
      return false;
    },
    markStopRequested,
    prepareAutomaticResumeAdmission: (sessionIdRaw: string) => {
      const sessionId = normalizeSessionId(sessionIdRaw);
      const admittedStop = stopRequestedBySessionId.get(sessionId);
      const allowed = admittedStop?.active !== true;
      return () => allowed && stopRequestedBySessionId.get(sessionId) === admittedStop;
    },
    prepareFreshExplicitResumeAdmission: (sessionIdRaw: string) => {
      const sessionId = normalizeSessionId(sessionIdRaw);
      let admittedStopRequest = sessionId
        ? stopRequestedBySessionId.get(sessionId) ?? null
        : null;
      const isCurrent = () => Boolean(sessionId)
        && (stopRequestedBySessionId.get(sessionId) ?? null) === admittedStopRequest;
      return {
        // An earlier Stop permits this new intent; a later Stop retires it.
        isCurrent,
        retireIncumbent: (request) => {
          const belongsToThisResume = isCurrent();
          markStopRequested(sessionId, request);
          // Advance only across this admission's own synchronous retirement.
          // An external Stop before or after this call still retires the admission.
          if (belongsToThisResume) admittedStopRequest = stopRequestedBySessionId.get(sessionId) ?? null;
        },
        complete: () => {
          if (!isCurrent()) return;
          // Keep the actual last Stop witness so a completed explicit Resume cannot
          // revive automatic launch preparation that began before that Stop.
          if (admittedStopRequest) admittedStopRequest.active = false;
          stateBySessionId.get(sessionId)?.controller.clearStopRequested();
        },
      };
    },
    handleUnexpectedExit: (trackedSession: TrackedSession, exit: DaemonChildExit, options) => {
      if (trackedSession.startedBy !== 'daemon') return 'ignored';
      const sessionId = normalizeSessionId(trackedSession.happySessionId);
      if (!sessionId) return 'ignored';
      const forceRestart = options?.forceRestart === true;
      const stopRequest = readActiveStopRequest(sessionId);
      if (stopRequest) return 'ignored';

      if (exit.code === SESSION_RUNNER_EXIT_CODES.CONTINUATION_UNREACHABLE) {
        endRespawnCycle(sessionId);
        // Keep requester custody until the existing exact-activation failure
        // owner has read Home. This terminal exit bypasses the retry preflight.
        beginTerminalSettlement({ sessionId, previousPid: trackedSession.pid, reason: 'continuation_unreachable' }, async () => {
          try {
            await params.readStartupFailure?.({ sessionId, trackedSession, runnerExitCode: exit.code });
          } catch (error) {
            params.logDebug('[DAEMON RUN] Continuation failure observation unavailable', {
              sessionId, phase: 'pending_activation_failure', exitCode: exit.code,
              ...readUnexpectedActionErrorDiagnosticV1(error),
            });
          }
          params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (continuation unreachable)`);
        });
        return 'terminal';
      }

      if (!params.enabled && !forceRestart) return 'ignored';

      if (exit.code === SESSION_RUNNER_EXIT_CODES.TERMINAL_FOLLOW_ADMISSION_FAILED) {
        endRespawnCycle(sessionId);
        params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (terminal follow admission failed)`);
        beginTerminalSettlement({
          sessionId,
          previousPid: trackedSession.pid,
          reason: 'terminal_follow_admission_failed',
        });
        return 'terminal';
      }

      // Native open/refusal retires this exact startup context. Before that
      // boundary, exit fails the original operation; its credential restart
      // intent cannot authorize a successor after the parent has failed.
      if (trackedSession.projectSetupOperation) {
        endRespawnCycle(sessionId);
        params.logWarn(`[DAEMON RUN] Respawn suppressed for session ${sessionId} (original startup exited before native open)`);
        beginTerminalSettlement({ sessionId, previousPid: trackedSession.pid, reason: 'startup_operation_failed' });
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
        beginTerminalSettlement({
          sessionId,
          previousPid: trackedSession.pid,
          reason: 'missing_spawn_options',
        });
        return 'terminal';
      }

      if (!isSessionRunnerColdResumeSupported({
        trackedSession,
        ...(options?.spawnOptionsOverride
          ? {
              spawnOptionsOverride:
                options.spawnOptionsOverride,
            }
          : {}),
      })) {
        endRespawnCycle(sessionId);
        params.logWarn(
          `[DAEMON RUN] Respawn suppressed for session ${sessionId} `
          + '(startup-instruction cold-resume effectiveness is unproven)',
        );
        beginTerminalSettlement({
          sessionId,
          previousPid: trackedSession.pid,
          reason: 'startup_instructions_cold_resume_unproven',
        });
        return 'terminal';
      }

      const vendorResumeId = readNonBlankOpaqueIdentifier(trackedSession.vendorResumeId) ?? '';
      const controller = getOrCreateController(sessionId);
      if (forceRestart) {
        // Mark this as an intended (connected-service-initiated) restart cycle so its whole storm —
        // the initial relaunch plus any retries — runs on the intended budget, never the generic
        // crash counter (RR-2).
        const state = stateBySessionId.get(sessionId);
        if (state) state.intended = true;
      }
      const event: TerminationEvent = forceRestart ? {
        type: 'spawn_error', errorName: 'PlannedRunnerRestart',
        errorMessage: options?.restartReason ?? exit.reason,
      } : toTerminationEvent(exit);
      const decision = decideRestartForCycle(sessionId, controller, event);
      if (decision.type === 'no_restart') {
        if (decision.reason.startsWith('max_restarts_exceeded') || decision.reason.startsWith('max_intended_restarts_exceeded')) {
          params.logWarn(`[DAEMON RUN] Session ${sessionId} crashed; respawn suppressed (${decision.reason})`);
        }
        endRespawnCycle(sessionId);
        beginTerminalSettlement({
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
        trackedSession,
      );
      return 'scheduled';
    },
  };
}
