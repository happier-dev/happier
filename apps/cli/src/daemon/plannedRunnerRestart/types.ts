import type {
  RestartAllSessionRunnersResultV1,
  RestartSessionRunnerRequestV1,
  RestartSessionRunnerResultV1,
  RestartSessionRunnerStatusV1,
  SessionRunnerRestartModeV1,
  SessionRunnerRestartReasonV1,
  SessionRunnerRestartDisabledReason,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceSwitchTarget } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

export type PlannedRunnerRestartReason =
  | 'connected_service_switch'
  | 'temporary_throttle_recovery'
  | 'version_runtime_refresh';

export type PlannedRunnerRestartPolicy =
  | 'defer_until_turn_boundary'
  | 'defer_until_idle';

export type PlannedRunnerRestartSource = 'manual' | 'automatic';

export type PlannedRunnerRestartMode = SessionRunnerRestartModeV1;
export type PlannedRunnerRestartRequestReason = SessionRunnerRestartReasonV1;

export type PlannedRunnerRestartSignalResult = Readonly<{
  status: 'requested' | 'process_already_missing' | 'skipped_stale_owner';
}>;

export type PlannedRunnerRestartNotSignaledReason =
  | 'stale_owner'
  | 'unsafe_process'
  | 'superseded'
  | 'activity_in_progress'
  | SessionRunnerRestartDisabledReason;

export type PlannedRunnerRestartSignalGateResult =
  | boolean
  | SessionRunnerRestartDisabledReason;

export type PlannedRunnerRestartSignalRequest = Readonly<{
  tracked: TrackedSession;
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
    runSwitch: () => Promise<void>;
  }>) => Promise<void>;
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
