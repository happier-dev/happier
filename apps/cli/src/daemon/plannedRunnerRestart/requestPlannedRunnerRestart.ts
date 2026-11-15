import { ConnectedServiceSwitchDeferralConflictError, isSameConnectedServiceSwitchTarget } from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { isPidSafeHappySessionProcess } from '../pidSafety';
import type {
  PlannedRunnerRestartDeferral,
  PlannedRunnerRestartNotSignaledReason,
  PlannedRunnerRestartSignalGateResult,
  PlannedRunnerRestartSignalRequest,
  PlannedRunnerRestartSignalResult,
} from './types';
import type { TrackedSession } from '../types';
import { resolveTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';
import { resolveTrackedSessionRunnerActivity } from '../sessionRunnerRuntime/resolveRuntimeState';
import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';
import type { OwnerRemainderCapture } from '../processes/endOwnerRemainder';
import { SessionRunnerRestartAdmissionUnsupportedError, type SessionRunnerRestartAdmissionRelease } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { isCurrentTrackedSession, type ReadonlyTrackedSessionMap, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

type RestartCompletionWaiter = Readonly<{
  promise: Promise<RestartSessionRunnerCompletion>;
  start: () => void;
  cancel: () => void;
  retire?: () => void;
}>;

export type RequestPlannedRunnerRestartParams = Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  completion?: Readonly<{
    hasPending: () => boolean;
    join: () => Promise<RestartSessionRunnerCompletion> | null;
    create: () => RestartCompletionWaiter;
  }>;
  observeRunnerRetirement?: (tracked: TrackedSession, sessionId: string) => void | boolean | Promise<void | boolean>;
  captureRunnerRemainder?: (tracked: TrackedSession, sessionId: string) => Promise<OwnerRemainderCapture | undefined>;
  deferral: PlannedRunnerRestartDeferral;
  /**
   * Sessions with a planned restart in flight (requested through respawn). Keyed by Session, not
   * process: Sessions of one session host share a pid but restart independently.
   */
  restartRequestedSessions: Set<SessionTrackingKey>;
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  requestSignal: (request: PlannedRunnerRestartSignalRequest) => Promise<PlannedRunnerRestartSignalResult>;
  canSignal?: (signal: AbortSignal) => PlannedRunnerRestartSignalGateResult | Promise<PlannedRunnerRestartSignalGateResult>;
  /** Receiving creation admission remains closed through activity/capture checks and the signal. */
  prepareSignal?: (signal: AbortSignal) => Promise<SessionRunnerRestartAdmissionRelease | null>;
  reason?: string;
  isShuttingDown?: () => boolean;
  isProcessSafeToSignal?: (params: Readonly<{
    pid: number;
    expectedProcessCommandHash?: string;
    expectedProcessStartTimeMs?: number;
  }>) => Promise<boolean>;
  observeProcessMissing?: (tracked: TrackedSession) => void;
  clearRestartIntent?: (trackingKey: SessionTrackingKey, logMessage: string) => void;
  onSignalFailureLogMessage?: string;
  logDebug?: (message: string, payload?: unknown) => void;
  logWarn?: (message: string, payload?: unknown) => void;
}>;

// Capture the selected deferred callback's result, including its completion promise. A joined
// caller may resume after retirement has removed the Session reservation and settled the handoff.
class PlannedRunnerRestartExecution {
  constructor(readonly outcome: Readonly<{
    tracked: TrackedSession;
    deferral: PlannedRunnerRestartDeferral;
    signaled: boolean;
    notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
    completionPromise?: Promise<RestartSessionRunnerCompletion>;
  }>) {}
}

export async function requestPlannedRunnerRestart(
  params: RequestPlannedRunnerRestartParams,
): Promise<Readonly<{
  signaled: boolean;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  completion?: RestartSessionRunnerCompletion;
}>> {
  let signaled = false;
  let notSignaledReason: PlannedRunnerRestartNotSignaledReason | undefined;
  const isProcessSafeToSignal = params.isProcessSafeToSignal ?? isPidSafeHappySessionProcess;
  const expectedPid = params.tracked.pid;
  const trackingKey = params.tracked.trackingKey;
  const expectedProcessCommandHash =
    params.tracked.processCommandHash?.trim() ?? '';
  const expectedProcessStartTimeMs = params.tracked.processStartTimeMs;
  // Public restart/model guards describe the executable. The launcher remains
  // the physical signal/tree and map key, so validate both without relabeling either birth.
  const runnerIdentity = resolveTrackedSessionRunnerIdentity(params.tracked);
  const expectedRunner = runnerIdentity ? { ...runnerIdentity } : null;
  if (
    !Number.isInteger(expectedPid)
    || expectedPid <= 0
    || !Number.isInteger(expectedProcessStartTimeMs)
    || (expectedProcessStartTimeMs ?? -1) < 0
    || !expectedRunner
    || !Number.isInteger(expectedRunner.pid) || expectedRunner.pid <= 0
    || !Number.isInteger(expectedRunner.processStartTimeMs)
    || (expectedRunner.processStartTimeMs ?? -1) < 0
  ) {
    return {
      signaled: false,
      notSignaledReason: 'unsafe_process',
    };
  }

  const completionState: {
    waiter?: RestartCompletionWaiter;
    promise?: Promise<RestartSessionRunnerCompletion>;
  } = {};
  let ownsReservation = false;
  const clearUnsignaledRequest = (message: string): void => {
    completionState.waiter?.cancel();
    if (!ownsReservation) return;
    ownsReservation = false;
    if (params.tracked.plannedRestartReason === params.reason) delete params.tracked.plannedRestartReason;
    params.restartRequestedSessions.delete(trackingKey);
    params.clearRestartIntent?.(trackingKey, message);
  };
  const captureExecution = () => new PlannedRunnerRestartExecution({
    tracked: params.tracked,
    deferral: params.deferral,
    signaled,
    ...(notSignaledReason ? { notSignaledReason } : {}),
    ...(completionState.promise ? { completionPromise: completionState.promise } : {}),
  });
  const runSwitch = async (deferralSignal?: AbortSignal): Promise<PlannedRunnerRestartExecution> => {
    const joined = params.completion?.join();
    if (joined) {
      signaled = true;
      completionState.promise = joined;
      return captureExecution();
    }
    if (params.restartRequestedSessions.has(trackingKey) || params.completion?.hasPending()) {
      notSignaledReason = 'restart_already_running';
      return captureExecution();
    }
    params.restartRequestedSessions.add(trackingKey);
    ownsReservation = true;
    completionState.waiter = params.completion?.create();
    completionState.promise = completionState.waiter?.promise;
    // Reserve completion before waiting so equivalent callers join the same attempt.
    // The respawn budget starts only when the signal is admitted; activity waits
    // remain cancellable by their containing daemon/deferral lifetime.
    const lifetime = new AbortController();
    void completionState.promise?.then(() => lifetime.abort());
    const cancelBeforeSignal = () => lifetime.abort(deferralSignal?.reason);
    deferralSignal?.addEventListener('abort', cancelBeforeSignal, { once: true });
    if (deferralSignal?.aborted) cancelBeforeSignal();
    const signal = lifetime.signal;
    let ownerStillCurrent = true;
    let missingProcessObserved = false;
    const trackedWitnessIsCurrent = (): boolean => {
      if (!ownsReservation) return false;
      ownerStillCurrent =
        isCurrentTrackedSession(params.trackedSessionsByKey, params.tracked);
      if (!ownerStillCurrent) {
        notSignaledReason = 'stale_owner';
        return false;
      }
      if (
        params.tracked.pid !== expectedPid
        || (params.tracked.processCommandHash?.trim() ?? '')
          !== expectedProcessCommandHash
        || params.tracked.processStartTimeMs
          !== expectedProcessStartTimeMs
      ) {
        notSignaledReason = 'unsafe_process';
        return false;
      }
      const currentRunner = resolveTrackedSessionRunnerIdentity(params.tracked);
      if (currentRunner?.pid !== expectedRunner.pid
        || currentRunner?.processStartTimeMs !== expectedRunner.processStartTimeMs
        || currentRunner?.processCommandHash !== expectedRunner.processCommandHash) {
        notSignaledReason = 'runner_identity_changed';
        return false;
      }
      return true;
    };
    const exactProcessWitnessIsCurrent = async (): Promise<boolean> => {
      if (!trackedWitnessIsCurrent()) return false;
      const safe = await isProcessSafeToSignal({
        pid: expectedPid,
        expectedProcessCommandHash,
        expectedProcessStartTimeMs,
      });
      if (!safe) {
        notSignaledReason = 'unsafe_process';
        return false;
      }
      if ((expectedRunner.pid !== expectedPid || expectedRunner.processStartTimeMs !== expectedProcessStartTimeMs)
        && !await isProcessSafeToSignal({
          pid: expectedRunner.pid,
          expectedProcessCommandHash: expectedRunner.processCommandHash,
          expectedProcessStartTimeMs: expectedRunner.processStartTimeMs,
        })) {
        notSignaledReason = 'runner_identity_changed';
        return false;
      }
      return trackedWitnessIsCurrent();
    };
    let signalResult: PlannedRunnerRestartSignalResult = { status: 'skipped_stale_owner' };
    let releaseSignalAdmission: SessionRunnerRestartAdmissionRelease | undefined;
    try {
      signalResult = await params.requestSignal({
        tracked: params.tracked,
        shouldSignal: async () => {
          if (!await exactProcessWitnessIsCurrent()) return false;
          if (params.prepareSignal && !releaseSignalAdmission) {
            const receivingPid = params.tracked.sessionRunnerPid ?? expectedPid;
            let release: SessionRunnerRestartAdmissionRelease | null;
            try { release = await params.prepareSignal(signal); }
            catch (error) {
              if (!(error instanceof SessionRunnerRestartAdmissionUnsupportedError)) throw error;
              params.tracked.runnerRestartAdmissionUnsupportedPid = receivingPid;
              notSignaledReason = 'restart_admission_unsupported';
              return false;
            }
            if (!release) { notSignaledReason = 'activity_observation_unavailable'; return false; }
            releaseSignalAdmission = release;
          }
          const activityStillAllowsSignal = async (): Promise<boolean> => {
            const allowed = (await params.canSignal?.(signal)) ?? true;
            if (allowed === true) return true;
            notSignaledReason = allowed === false ? 'activity_in_progress' : allowed;
            return false;
          };
          if (!await activityStillAllowsSignal()) return false;
          if (params.captureRunnerRemainder) {
            const captured = await params.captureRunnerRemainder(params.tracked, params.sessionId);
            if (!captured || captured.processFailure) {
              notSignaledReason = 'remainder_capture_unavailable';
              return false;
            }
            params.tracked.ownerRemainderCapture = captured;
            // OS capture can suspend while native work starts on this runner.
            if (!await activityStillAllowsSignal()) return false;
          }
          if (!await exactProcessWitnessIsCurrent()) return false;
          if (signal.aborted || releaseSignalAdmission?.signal.aborted) {
            notSignaledReason = 'activity_in_progress';
            return false;
          }
          // Shutdown can begin during either awaited process or activity probe.
          if (params.isShuttingDown?.()) {
            notSignaledReason = 'shutting_down';
            return false;
          }
          // Refresh and source-cutover requests have no connected-service deferral policy.
          // Read exact custody after every awaited probe; account switches retain their own policy.
          const foreground = params.deferral.kind === 'none'
            ? resolveTrackedSessionRunnerActivity(params.tracked) : null;
          if (foreground) {
            notSignaledReason = foreground.reasonCode;
            return false;
          }
          params.tracked.plannedRestartReason = params.reason;
          completionState.waiter?.start();
          return true;
        },
        onSignalFailure: (error) => {
          clearUnsignaledRequest(params.onSignalFailureLogMessage
            ?? '[DAEMON RUN] Failed to clear planned runner restart intent after signal failure');
          params.logWarn?.(
            params.onSignalFailureLogMessage ?? '[DAEMON RUN] Failed to signal planned runner restart',
            error,
          );
        },
        onProcessAlreadyMissing: () => {
          missingProcessObserved = true;
          if (params.observeProcessMissing) {
            params.observeProcessMissing(params.tracked);
          } else {
            params.logWarn?.('[DAEMON RUN] Planned runner restart process was already missing before exit observer was ready');
          }
        },
      });
    } finally {
      try {
        if (signalResult.status === 'skipped_stale_owner') await releaseSignalAdmission?.();
      } finally {
        // The deferral queue retires its callback signal after applying a switch.
        // Once signalled, receiver retirement/completion owns the hold instead.
        deferralSignal?.removeEventListener('abort', cancelBeforeSignal);
        // A signalled receiver retains the in-flight hold through physical exit.
        // Its transport retirement (or completion) cancels that same request.
        if (signalResult.status === 'skipped_stale_owner') lifetime.abort();
      }
    }

    if (!ownerStillCurrent || signalResult.status === 'skipped_stale_owner') {
      clearUnsignaledRequest('[DAEMON RUN] Failed to clear stale planned runner restart intent after skipped signal');
      if (notSignaledReason === 'unsafe_process') {
        params.logWarn?.('[DAEMON RUN] Refusing planned session runner restart because PID identity no longer matches tracked runner', {
          sessionId: params.sessionId,
          pid: expectedPid,
        });
      }
      return captureExecution();
    }

    if (signalResult.status === 'process_already_missing' && !missingProcessObserved) {
      if (params.observeProcessMissing) {
        params.observeProcessMissing(params.tracked);
      } else {
        params.logWarn?.('[DAEMON RUN] Planned runner restart process was already missing before exit observer was ready');
      }
    }

    signaled = true;
    completionState.waiter?.start();
    try {
      const observation = params.observeRunnerRetirement?.(params.tracked, params.sessionId);
      void Promise.resolve(observation).then(retired => {
        if (retired === false) completionState.waiter?.retire?.();
      }).catch((error) => {
        completionState.waiter?.retire?.();
        params.logWarn?.('[DAEMON RUN] Failed to observe planned runner retirement', error);
      });
    } catch (error) {
      completionState.waiter?.retire?.();
      params.logWarn?.('[DAEMON RUN] Failed to observe planned runner retirement', error);
    }
    return captureExecution();
  };

  let selectedExecution: unknown;
  try {
    if (params.deferral.kind === 'none') {
      selectedExecution = await runSwitch();
    } else {
      selectedExecution = await params.deferral.turnDeferralQueue.requestSwitch({
        sessionId: params.sessionId,
        source: params.deferral.source,
        policy: params.deferral.policy,
        target: params.deferral.target,
        runSwitch,
      });
    }
  } catch (error) {
    if (!signaled) clearUnsignaledRequest('[DAEMON RUN] Failed to clear planned runner restart intent after request failure');
    if (error instanceof ConnectedServiceSwitchDeferralConflictError && error.code === 'switch_cancelled') {
      params.logDebug?.('[DAEMON RUN] Planned runner deferred restart superseded by a newer switch request', {
        sessionId: params.sessionId,
        deferralKind: params.deferral.kind,
      });
      return { signaled: false, notSignaledReason: 'superseded' };
    }
    throw error;
  }

  if (!(selectedExecution instanceof PlannedRunnerRestartExecution)) {
    return { signaled: false, notSignaledReason: 'restart_already_running' };
  }
  const selected = selectedExecution.outcome;
  if (selected.tracked !== params.tracked || selected.deferral.kind !== params.deferral.kind
    || (selected.deferral.kind === 'connected_service_switch' && params.deferral.kind === 'connected_service_switch'
      && !isSameConnectedServiceSwitchTarget(selected.deferral.target, params.deferral.target))) {
    return { signaled: false, notSignaledReason: 'restart_already_running' };
  }
  signaled = selected.signaled;
  notSignaledReason = selected.notSignaledReason;
  if (signaled && selected.completionPromise) {
    const completion = await selected.completionPromise;
    if (completion.ok === false && completion.diagnostics?.respawnTerminalReason === 'cancelled_before_signal') {
      return { signaled: false, notSignaledReason: 'restart_already_running' };
    }
    return { signaled: true, completion };
  }
  if (signaled || !notSignaledReason) return { signaled };
  return { signaled, notSignaledReason };
}
