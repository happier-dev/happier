import { ConnectedServiceSwitchDeferralConflictError } from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { isPidSafeHappySessionProcess } from '../pidSafety';
import type {
  PlannedRunnerRestartDeferral,
  PlannedRunnerRestartNotSignaledReason,
  PlannedRunnerRestartSignalGateResult,
  PlannedRunnerRestartSignalRequest,
  PlannedRunnerRestartSignalResult,
} from './types';
import type { TrackedSession } from '../types';

export type RequestPlannedRunnerRestartParams = Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  deferral: PlannedRunnerRestartDeferral;
  restartRequestedPids: Set<number>;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  requestSignal: (request: PlannedRunnerRestartSignalRequest) => Promise<PlannedRunnerRestartSignalResult>;
  canSignal?: () => PlannedRunnerRestartSignalGateResult | Promise<PlannedRunnerRestartSignalGateResult>;
  isProcessSafeToSignal?: (params: Readonly<{
    pid: number;
    expectedProcessCommandHash?: string;
  }>) => Promise<boolean>;
  observeProcessMissing?: (tracked: TrackedSession) => void;
  clearRestartIntentForPid?: (pid: number, logMessage: string) => void;
  onSignalFailureLogMessage?: string;
  logDebug?: (message: string, payload?: unknown) => void;
  logWarn?: (message: string, payload?: unknown) => void;
}>;

function clearRestartIntent(params: Readonly<{
  pid: number;
  clearRestartIntentForPid?: (pid: number, logMessage: string) => void;
  message: string;
}>): void {
  params.clearRestartIntentForPid?.(params.pid, params.message);
}

export async function requestPlannedRunnerRestart(
  params: RequestPlannedRunnerRestartParams,
): Promise<Readonly<{
  signaled: boolean;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
}>> {
  let signaled = false;
  let notSignaledReason: PlannedRunnerRestartNotSignaledReason | undefined;
  const isProcessSafeToSignal = params.isProcessSafeToSignal ?? isPidSafeHappySessionProcess;

  const runSwitch = async (): Promise<void> => {
    if (params.restartRequestedPids.has(params.tracked.pid)) {
      notSignaledReason = 'restart_already_running';
      return;
    }
    params.restartRequestedPids.add(params.tracked.pid);
    let ownerStillCurrent = true;
    let missingProcessObserved = false;
    const signalResult = await params.requestSignal({
      tracked: params.tracked,
      shouldSignal: async () => {
        ownerStillCurrent = params.pidToTrackedSession.get(params.tracked.pid) === params.tracked;
        if (!ownerStillCurrent) {
          notSignaledReason = 'stale_owner';
          return false;
        }
        const safe = await isProcessSafeToSignal({
          pid: params.tracked.pid,
          ...(params.tracked.processCommandHash
            ? { expectedProcessCommandHash: params.tracked.processCommandHash }
            : {}),
        });
            if (!safe) {
              notSignaledReason = 'unsafe_process';
              return false;
            }
            const allowedByActivityGate = (await params.canSignal?.()) ?? true;
            if (allowedByActivityGate !== true) {
              notSignaledReason = allowedByActivityGate === false
                ? 'activity_in_progress'
                : allowedByActivityGate;
              return false;
            }
            return true;
          },
      onSignalFailure: (error) => {
        params.restartRequestedPids.delete(params.tracked.pid);
        clearRestartIntent({
          pid: params.tracked.pid,
          clearRestartIntentForPid: params.clearRestartIntentForPid,
          message: params.onSignalFailureLogMessage
            ?? '[DAEMON RUN] Failed to clear planned runner restart intent after signal failure',
        });
        params.logDebug?.(
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

    if (!ownerStillCurrent || signalResult.status === 'skipped_stale_owner') {
      params.restartRequestedPids.delete(params.tracked.pid);
      clearRestartIntent({
        pid: params.tracked.pid,
        clearRestartIntentForPid: params.clearRestartIntentForPid,
        message: '[DAEMON RUN] Failed to clear stale planned runner restart intent after skipped signal',
      });
      if (notSignaledReason === 'unsafe_process') {
        params.logWarn?.('[DAEMON RUN] Refusing planned session runner restart because PID identity no longer matches tracked runner', {
          sessionId: params.sessionId,
          pid: params.tracked.pid,
        });
      }
      return;
    }

    if (signalResult.status === 'process_already_missing' && !missingProcessObserved) {
      if (params.observeProcessMissing) {
        params.observeProcessMissing(params.tracked);
      } else {
        params.logWarn?.('[DAEMON RUN] Planned runner restart process was already missing before exit observer was ready');
      }
    }

    signaled = true;
  };

  try {
    if (params.deferral.kind === 'none') {
      await runSwitch();
    } else {
      await params.deferral.turnDeferralQueue.requestSwitch({
        sessionId: params.sessionId,
        source: params.deferral.source,
        policy: params.deferral.policy,
        target: params.deferral.target,
        runSwitch,
      });
    }
  } catch (error) {
    if (error instanceof ConnectedServiceSwitchDeferralConflictError && error.code === 'switch_cancelled') {
      params.logDebug?.('[DAEMON RUN] Planned runner deferred restart superseded by a newer switch request', {
        sessionId: params.sessionId,
        deferralKind: params.deferral.kind,
      });
      return { signaled: false, notSignaledReason: 'superseded' };
    }
    throw error;
  }

  if (signaled || !notSignaledReason) return { signaled };
  return { signaled, notSignaledReason };
}
