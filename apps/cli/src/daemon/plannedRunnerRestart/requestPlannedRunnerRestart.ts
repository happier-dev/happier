import type { TrackedSession } from '@/daemon/types';
import { ConnectedServiceSwitchDeferralConflictError } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { isPidSafeHappySessionProcess } from '@/daemon/pidSafety';
import {
  SESSION_RUNNER_RESTART_DISABLED_REASONS,
  type SessionRunnerRestartDisabledReason,
} from '@happier-dev/protocol';

import { isSamePlannedRunnerRestartIntent, isRestartCancelledBeforeSignal, type RestartCompletionWaiter, type RestartCompletionWaiters } from './completionWaiters';
import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';
import { resolveSessionRunnerActivityDisabledReason } from '../sessionRunnerRuntime/resolveActivityDisabledReason';

import type {
  PlannedRunnerRestartIntent,
  PlannedRunnerRestartDeferral,
  PlannedRunnerRestartNotSignaledReason,
  PlannedRunnerRestartReason,
  PlannedRunnerRestartSignalActivityGateResult,
  PlannedRunnerRestartSignalRequest,
  PlannedRunnerRestartSignalResult,
} from './types';

async function runWithDeferral(input: Readonly<{
  sessionId: string;
  deferral: PlannedRunnerRestartDeferral;
  runSwitch: () => Promise<unknown>;
}>): Promise<unknown> {
  if (input.deferral.kind === 'none') {
    return await input.runSwitch();
  }
  return await input.deferral.turnDeferralQueue.requestSwitch({
    sessionId: input.sessionId,
    source: input.deferral.source,
    policy: input.deferral.policy,
    target: input.deferral.target,
    runSwitch: input.runSwitch,
  });
}

const RESTART_DISABLED_REASON_SET = new Set<string>(SESSION_RUNNER_RESTART_DISABLED_REASONS);

function normalizeActivityDisabledReason(
  value: PlannedRunnerRestartSignalActivityGateResult,
): SessionRunnerRestartDisabledReason | null {
  return typeof value === 'string' && RESTART_DISABLED_REASON_SET.has(value) ? value : null;
}

// The queue also executes pre-turn account switches whose callbacks return void. Keep the
// selected restart result nominal so a coalesced caller cannot mistake that other operation for
// a restart, and preserve the completion promise even if retirement settles before it resumes.
class PlannedRunnerRestartExecution {
  constructor(readonly outcome: Readonly<{
    intent: PlannedRunnerRestartIntent;
    signaled: boolean;
    completionPromise: Promise<RestartSessionRunnerCompletion> | null;
    notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
    activityDisabledReason?: SessionRunnerRestartDisabledReason;
  }>) {}
}

export async function requestPlannedRunnerRestart(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  reason: PlannedRunnerRestartReason;
  deferral: PlannedRunnerRestartDeferral;
  restartRequestedPids: Set<number>;
  completionWaiters: RestartCompletionWaiters;
  awaitCompletion?: boolean;
  observeRunnerRetirement?: (tracked: TrackedSession, sessionId: string) => void | Promise<void>;
  onRestartSignaled?: () => void;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  requestSignal: (request: PlannedRunnerRestartSignalRequest) => Promise<PlannedRunnerRestartSignalResult>;
  canSignal?: () => PlannedRunnerRestartSignalActivityGateResult | Promise<PlannedRunnerRestartSignalActivityGateResult>;
  isShuttingDown?: () => boolean;
  isProcessSafeToSignal?: (params: Readonly<{
    pid: number;
    expectedProcessCommandHash?: string;
    expectedProcessInstanceFingerprint?: string;
  }>) => Promise<boolean>;
  observeProcessMissing?: (tracked: TrackedSession) => void;
  clearRestartIntentForPid?: (pid: number) => void;
  onSignalFailureLogMessage?: string;
  logDebug: (message: string, payload?: unknown) => void;
  logWarn?: (message: string, payload?: unknown) => void;
}>): Promise<Readonly<{
  signaled: boolean;
  completion?: RestartSessionRunnerCompletion;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  activityDisabledReason?: SessionRunnerRestartDisabledReason;
}>> {
  let signaled = false;
  let completionWaiter: RestartCompletionWaiter | null = null;
  let completionPromise: Promise<RestartSessionRunnerCompletion> | null = null;
  let ownsReservation = false;
  const intent: PlannedRunnerRestartIntent = {
    reason: input.reason,
    tracked: input.tracked,
    ...(input.deferral.kind === 'connected_service_switch' ? { target: input.deferral.target } : {}),
  };
  const clearUnsignaledRequest = () => {
    completionWaiter?.cancel();
    if (!ownsReservation) return;
    ownsReservation = false;
    input.restartRequestedPids.delete(input.tracked.pid);
    input.clearRestartIntentForPid?.(input.tracked.pid);
  };
  let notSignaledReason: PlannedRunnerRestartNotSignaledReason | undefined;
  let activityDisabledReason: SessionRunnerRestartDisabledReason | undefined;
  const isProcessSafeToSignal = input.isProcessSafeToSignal ?? isPidSafeHappySessionProcess;
  const captureExecution = () => new PlannedRunnerRestartExecution({
    intent, signaled, completionPromise, notSignaledReason, activityDisabledReason,
  });
  let selectedExecution: unknown;
  try {
    selectedExecution = await runWithDeferral({
      sessionId: input.sessionId,
      runSwitch: async () => {
        completionPromise = input.completionWaiters.join(input.sessionId, input.tracked.pid, intent);
        if (completionPromise) {
          signaled = true;
          return captureExecution();
        }
        if (input.restartRequestedPids.has(input.tracked.pid) || input.completionWaiters.join(input.sessionId, input.tracked.pid)) {
          notSignaledReason = 'duplicate_restart';
          return captureExecution();
        }
        completionWaiter = input.completionWaiters.create(input.sessionId, input.tracked.pid, intent);
        completionPromise = completionWaiter.promise;
        ownsReservation = true;
        input.restartRequestedPids.add(input.tracked.pid);
        let ownerStillCurrent = true;
        let missingProcessObserved = false;

        const signalResult = await input.requestSignal({
          tracked: input.tracked,
          shouldSignal: async () => {
            // Deferral cancellation may release this request while the signal delay or an
            // awaited probe is pending. A released request must never send a late SIGTERM.
            if (!ownsReservation) return false;
            ownerStillCurrent = input.pidToTrackedSession.get(input.tracked.pid) === input.tracked;
            if (!ownerStillCurrent) {
              notSignaledReason = 'stale_owner';
              return false;
            }
            const safe = await isProcessSafeToSignal({
              pid: input.tracked.pid,
              ...(input.tracked.processCommandHash
                ? { expectedProcessCommandHash: input.tracked.processCommandHash }
                : {}),
              ...(input.tracked.processInstanceFingerprint
                ? { expectedProcessInstanceFingerprint: input.tracked.processInstanceFingerprint }
                : {}),
            });
            if (!ownsReservation) return false;
            if (!safe) {
              notSignaledReason = 'unsafe_process';
              return false;
            }
            const activityGateResult = await input.canSignal?.();
            if (!ownsReservation) return false;
            // Version refresh never interrupts exact foreground custody. Account switches retain
            // their separate forced-boundary policy, which may intentionally interrupt a turn.
            const exactActivityDisabledReason = (input.reason === 'version_runtime_refresh'
              ? resolveSessionRunnerActivityDisabledReason(input.sessionId, {}, input.tracked)
              : null) ?? normalizeActivityDisabledReason(activityGateResult);
            if (exactActivityDisabledReason || activityGateResult === false) {
              notSignaledReason = 'activity_in_progress';
              activityDisabledReason = exactActivityDisabledReason ?? undefined;
              return false;
            }
            // Final gate after every awaited probe: never stop a runner once daemon shutdown began.
            if (input.isShuttingDown?.()) {
              notSignaledReason = 'shutting_down';
              return false;
            }
            return true;
          },
          onSignalFailure: (error) => {
            clearUnsignaledRequest();
            if (input.onSignalFailureLogMessage) {
              input.logWarn?.(input.onSignalFailureLogMessage, error);
            }
          },
          onProcessAlreadyMissing: () => {
            missingProcessObserved = true;
            input.observeProcessMissing?.(input.tracked);
          },
        });

        if (signalResult.status === 'skipped_stale_owner' && !notSignaledReason) {
          notSignaledReason = 'stale_owner';
        }
        if (signalResult.status === 'skipped_duplicate_restart') {
          notSignaledReason = 'duplicate_restart';
        }
        if (signalResult.status === 'skipped_terminal_restart') {
          notSignaledReason = 'terminal_restart';
        }
        if (
          !ownerStillCurrent
          || signalResult.status === 'skipped_stale_owner'
          || signalResult.status === 'skipped_duplicate_restart'
          || signalResult.status === 'skipped_terminal_restart'
        ) {
          clearUnsignaledRequest();
          if (notSignaledReason === 'unsafe_process') {
            input.logWarn?.('[DAEMON RUN] Refusing planned session runner restart because PID identity no longer matches tracked runner', {
              sessionId: input.sessionId,
              pid: input.tracked.pid,
              reason: input.reason,
            });
          }
          return captureExecution();
        }
        if (signalResult.status === 'process_already_missing' && !missingProcessObserved) {
          input.observeProcessMissing?.(input.tracked);
        }
        signaled = true;
        try {
          input.onRestartSignaled?.();
        } catch (error) {
          input.logWarn?.('[DAEMON RUN] Failed to publish planned runner restart notification', error);
        }
        // Reattached runners have no child exit event. The daemon supplies the same physical-exit
        // observer for every planned restart, using the existing completion window.
        try {
          const observation = input.observeRunnerRetirement?.(input.tracked, input.sessionId);
          if (observation) void observation.catch((error) => {
            input.logWarn?.('[DAEMON RUN] Failed to observe planned runner retirement', error);
          });
        } catch (error) {
          input.logWarn?.('[DAEMON RUN] Failed to observe planned runner retirement', error);
        }
        return captureExecution();
      },
      deferral: input.deferral,
    });
  } catch (error) {
    if (!signaled) clearUnsignaledRequest();
    if (
      input.deferral.kind === 'connected_service_switch' &&
      error instanceof ConnectedServiceSwitchDeferralConflictError &&
      error.code === 'switch_cancelled'
    ) {
      input.logDebug('[DAEMON RUN] Planned runner restart superseded by a newer deferred request', {
        sessionId: input.sessionId,
        reason: input.reason,
        source: input.deferral.source,
      });
      return { signaled: false, notSignaledReason: 'superseded' };
    }
    throw error;
  }

  if (!(selectedExecution instanceof PlannedRunnerRestartExecution) || !isSamePlannedRunnerRestartIntent(selectedExecution.outcome.intent, intent)) {
    return { signaled: false, notSignaledReason: 'duplicate_restart' };
  }
  const selected = selectedExecution.outcome;
  signaled = selected.signaled;
  completionPromise = selected.completionPromise;
  notSignaledReason = selected.notSignaledReason;
  activityDisabledReason = selected.activityDisabledReason;
  if (signaled && (input.awaitCompletion || !ownsReservation) && completionPromise) {
    const completion = await completionPromise;
    if (isRestartCancelledBeforeSignal(completion)) return { signaled: false, notSignaledReason: 'duplicate_restart' };
    return { signaled: true, completion };
  }
  if (signaled || !notSignaledReason) return { signaled };
  return {
    signaled,
    notSignaledReason,
    ...(activityDisabledReason ? { activityDisabledReason } : {}),
  };
}
