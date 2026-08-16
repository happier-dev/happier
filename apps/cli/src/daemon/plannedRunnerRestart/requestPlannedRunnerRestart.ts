import type { TrackedSession } from '@/daemon/types';
import { ConnectedServiceSwitchDeferralConflictError } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { isPidSafeHappySessionProcess } from '@/daemon/pidSafety';
import {
  SESSION_RUNNER_RESTART_DISABLED_REASONS,
  type SessionRunnerRestartDisabledReason,
} from '@happier-dev/protocol';

import type {
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
  runSwitch: () => Promise<void>;
}>): Promise<void> {
  if (input.deferral.kind === 'none') {
    await input.runSwitch();
    return;
  }
  await input.deferral.turnDeferralQueue.requestSwitch({
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

export async function requestPlannedRunnerRestart(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  reason: PlannedRunnerRestartReason;
  deferral: PlannedRunnerRestartDeferral;
  restartRequestedPids: Set<number>;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  requestSignal: (request: PlannedRunnerRestartSignalRequest) => Promise<PlannedRunnerRestartSignalResult>;
  canSignal?: () => PlannedRunnerRestartSignalActivityGateResult | Promise<PlannedRunnerRestartSignalActivityGateResult>;
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
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  activityDisabledReason?: SessionRunnerRestartDisabledReason;
}>> {
  let signaled = false;
  let notSignaledReason: PlannedRunnerRestartNotSignaledReason | undefined;
  let activityDisabledReason: SessionRunnerRestartDisabledReason | undefined;
  const isProcessSafeToSignal = input.isProcessSafeToSignal ?? isPidSafeHappySessionProcess;
  try {
    await runWithDeferral({
      sessionId: input.sessionId,
      runSwitch: async () => {
        input.restartRequestedPids.add(input.tracked.pid);
        let ownerStillCurrent = true;
        let missingProcessObserved = false;

        const signalResult = await input.requestSignal({
          tracked: input.tracked,
          shouldSignal: async () => {
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
            if (!safe) {
              notSignaledReason = 'unsafe_process';
              return false;
            }
            const activityGateResult = await input.canSignal?.();
            const exactActivityDisabledReason = normalizeActivityDisabledReason(activityGateResult);
            if (exactActivityDisabledReason || activityGateResult === false) {
              notSignaledReason = 'activity_in_progress';
              activityDisabledReason = exactActivityDisabledReason ?? undefined;
              return false;
            }
            return true;
          },
          onSignalFailure: (error) => {
            input.restartRequestedPids.delete(input.tracked.pid);
            input.clearRestartIntentForPid?.(input.tracked.pid);
            if (input.onSignalFailureLogMessage) {
              input.logWarn?.(input.onSignalFailureLogMessage, error);
            }
          },
          onProcessAlreadyMissing: () => {
            missingProcessObserved = true;
            input.observeProcessMissing?.(input.tracked);
          },
        });

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
          input.restartRequestedPids.delete(input.tracked.pid);
          input.clearRestartIntentForPid?.(input.tracked.pid);
          if (notSignaledReason === 'unsafe_process') {
            input.logWarn?.('[DAEMON RUN] Refusing planned session runner restart because PID identity no longer matches tracked runner', {
              sessionId: input.sessionId,
              pid: input.tracked.pid,
              reason: input.reason,
            });
          }
          return;
        }
        if (signalResult.status === 'process_already_missing' && !missingProcessObserved) {
          input.observeProcessMissing?.(input.tracked);
        }
        signaled = true;
      },
      deferral: input.deferral,
    });
  } catch (error) {
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

  if (signaled || !notSignaledReason) return { signaled };
  return {
    signaled,
    notSignaledReason,
    ...(activityDisabledReason ? { activityDisabledReason } : {}),
  };
}
