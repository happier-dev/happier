import type {
  RestartAllSessionRunnersResultV1,
  RestartSessionRunnerRequestV1,
  RestartSessionRunnerResultV1,
  RestartSessionRunnerStatusV1,
  SessionRunnerRestartDisabledReason,
  SessionRunnerRestartModeV1,
  SessionRunnerRestartReasonV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceSwitchTarget } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

export type PlannedRunnerRestartReason =
  | 'connected_service_switch'
  | 'temporary_throttle_recovery'
  | 'version_runtime_refresh';

export type PlannedRunnerRestartIntent = Readonly<{
  reason: PlannedRunnerRestartReason;
  tracked: TrackedSession;
  target?: ConnectedServiceSwitchTarget;
}>;

export type PlannedRunnerRestartPolicy =
  | 'defer_until_turn_boundary'
  | 'defer_until_idle';

export type PlannedRunnerRestartSource = 'manual' | 'automatic';

export type PlannedRunnerRestartMode = SessionRunnerRestartModeV1;
export type PlannedRunnerRestartRequestReason = SessionRunnerRestartReasonV1;

export type PlannedRunnerRestartSignalResult = Readonly<{
  status:
    | 'requested'
    | 'process_already_missing'
    | 'skipped_stale_owner'
    | 'skipped_duplicate_restart'
    | 'skipped_terminal_restart';
}>;

export type PlannedRunnerRestartNotSignaledReason =
  | 'stale_owner'
  | 'unsafe_process'
  | 'superseded'
  | 'activity_in_progress'
  | 'duplicate_restart'
  | 'terminal_restart'
  | 'shutting_down';

export type PlannedRunnerRestartSignalActivityGateResult =
  | boolean
  | SessionRunnerRestartDisabledReason
  | null
  | undefined;

export type PlannedRunnerRestartSignalRequest = Readonly<{
  tracked: TrackedSession;
  runnerPid: number;
  shouldSignal: () => boolean | Promise<boolean>;
  onSignalFailure: (error: unknown) => void;
  onProcessAlreadyMissing: () => void;
}>;

export type PlannedRunnerRestartDeferralQueue = Readonly<{
  requestSwitch: (input: Readonly<{
    sessionId: string;
    policy: PlannedRunnerRestartPolicy;
    source: PlannedRunnerRestartSource;
    target: ConnectedServiceSwitchTarget;
    runSwitch: () => Promise<unknown>;
  }>) => Promise<unknown>;
}>;

export type PlannedRunnerRestartDeferral =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
    kind: 'connected_service_switch';
    source: PlannedRunnerRestartSource;
    policy: PlannedRunnerRestartPolicy;
    target: ConnectedServiceSwitchTarget;
    turnDeferralQueue: PlannedRunnerRestartDeferralQueue;
  }>;

export type RestartSessionRunnerStatus = RestartSessionRunnerStatusV1;
export type RestartSessionRunnerRequest = RestartSessionRunnerRequestV1;
export type RestartSessionRunnerResult = RestartSessionRunnerResultV1;
export type RestartAllSessionRunnersResult = RestartAllSessionRunnersResultV1;
