import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import type { HappierRuntimeWarning, HappierService } from '@happier-dev/cli-common/happierRuntime';

import type {
  BackgroundServiceRepairAction,
  BackgroundServiceRepairPlan,
} from '@/diagnostics/backgroundServiceRepair';

export type ServiceRepairTargetMode = 'default-following' | 'pinned' | 'legacy-pinned';

export type CurrentCliSummary = Readonly<{
  releaseChannel: PublicReleaseRingId | string;
  happierHomeDir: string | null;
  serverUrl: string | null;
  publicServerUrl: string | null;
}>;

export type AutomaticStartupEntry = Readonly<{
  id: string | null;
  label: string;
  platform: 'darwin' | 'linux' | 'win32' | null;
  backend: string | null;
  scope: 'user' | 'system' | null;
  releaseChannel: PublicReleaseRingId | string | null;
  targetMode: ServiceRepairTargetMode;
  instanceId: string | null;
  definitionPath: string | null;
  installed: boolean | null;
  running: boolean | null;
}>;

export type RunningDaemonEntry = Readonly<{
  label: string | null;
  releaseChannel: string | null;
  version: string | null;
  serviceManaged: boolean | null;
  managedByEntryId: string | null;
  profileId?: string | null;
}>;

export type ServiceRepairDaemonStatusSnapshot = Readonly<{
  daemon: Readonly<{
    running?: boolean | null;
    startedWithCliVersion?: string | null;
    startedWithPublicReleaseChannel?: string | null;
    serviceManaged?: boolean | null;
    serviceLabel?: string | null;
  }>;
  service?: Readonly<{
    installed?: boolean | null;
    running?: boolean | null;
  }>;
  auth?: Readonly<{
    authenticated?: boolean | null;
    machineRegistered?: boolean | null;
    machineId?: string | null;
    needsAuth?: boolean | null;
  }>;
}>;

export type BackgroundServiceHealthSummary = Readonly<{
  status: 'running' | 'stopped' | 'crash_looping' | 'unknown';
  reason?: string;
  details?: Readonly<{
    state?: string | null;
    restartCount?: number | null;
    lastExitStatus?: number | null;
  }>;
}>;

export type LocalRelayEntry = Readonly<{
  id: string;
  releaseChannel: string | null;
  url: string | null;
  active: boolean;
  installed?: boolean | null;
  running?: boolean | null;
  healthy?: boolean | null;
  version?: string | null;
  expectedVersion?: string | null;
  versionStale?: boolean | null;
  diagnostic?: string | null;
}>;

export type AuthProfileEntry = Readonly<{
  id: string;
  active?: boolean;
  authenticated: boolean | null;
  authState?: 'authenticated' | 'missing' | 'expired' | 'unknown';
  machineRegistered: boolean | null;
}>;

export type StackEntry = Readonly<{
  id: string;
  releaseChannel: string | null;
  active: boolean;
}>;

export type ServiceRepairAction =
  | Readonly<{
      kind: 'background-service-plan';
      planAction: BackgroundServiceRepairAction;
    }>
  | Readonly<{
      kind: 'run-command';
      command: string;
    }>
  | Readonly<{
      kind: 'switch-release-channel';
      releaseChannel: PublicReleaseRingId | string;
      command: string;
    }>
  | Readonly<{
      kind: 'run-setup';
      command: string;
    }>
  | Readonly<{
      kind: 'run-auth-login';
      profileId: string;
      command: string;
    }>
  | Readonly<{
      kind: 'register-machine';
      profileId: string;
      command: string;
    }>;

export type GuidedChannelSwitchAction = 'switch' | 'keep' | 'replace' | 'parallel';

export type GuidedRepairResult = Readonly<{
  executedActions: readonly string[];
  channelSwitchAction?: GuidedChannelSwitchAction;
  channelSwitchReleaseChannel?: PublicReleaseRingId | string;
}>;

export type ServiceRepairFinding = Readonly<{
  id: string;
  kind:
    | 'cli_self_update_available'
    | 'no_active_stack_yet'
    | 'channel_switch_recommended'
    | 'dev_on_hosted_cloud_informational'
    | 'multi_stack_detected_informational'
    | 'no_servers_configured'
    | 'auth_missing_for_profile'
    | 'auth_expired_for_active_profile'
    | 'machine_not_registered_for_profile'
    | 'automatic_startup_lane_mismatch'
    | 'automatic_startup_version_stale'
    | 'automatic_startup_stale_definition'
    | 'automatic_startup_legacy_channel_scoped'
    | 'automatic_startup_legacy_pinned_current_server'
    | 'automatic_startup_duplicate_default_following'
    | 'automatic_startup_duplicate_pinned_same_server'
    | 'automatic_startup_missing'
    | 'automatic_startup_foreign_home'
    | 'background_service_not_running'
    | 'background_service_crash_looping'
    | 'running_daemon_cli_mismatch'
    | 'running_daemon_duplicate_profile'
    | 'orphan_daemon_on_other_channel'
    | 'local_relay_lane_missing'
    | 'local_relay_version_stale'
    | 'local_relay_off_channel_leftovers';
  severity: 'info' | 'warning' | 'error';
  title: string;
  diagnostic: string | null;
  warningCode: HappierRuntimeWarning['code'] | null;
  entry: AutomaticStartupEntry | null;
  targetMode: ServiceRepairTargetMode | null;
  driftKind?: 'version-only' | 'cross-channel';
  recoveryStrategy?: 'service-restart' | 'daemon-takeover' | 'daemon-stop' | 'manual';
  actions: readonly ServiceRepairAction[];
}>;

export type ServiceRepairReport = Readonly<{
  currentCli: CurrentCliSummary;
  daemonStatus: ServiceRepairDaemonStatusSnapshot | null;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentlyRunning: readonly RunningDaemonEntry[];
  localRelays: readonly LocalRelayEntry[];
  authProfiles: readonly AuthProfileEntry[];
  stacks: readonly StackEntry[];
  findings: readonly ServiceRepairFinding[];
  manualWarnings: readonly string[];
}>;

export type ServiceRepairResolution = Readonly<{
  runtime: Readonly<{
    platform: 'darwin' | 'linux' | 'win32';
    channel: PublicReleaseRingId | string;
    uid: number | null;
    userHomeDir: string;
    happierHomeDir: string;
    serverUrl: string;
    publicServerUrl: string;
    nodePath: string;
    entryPath: string;
  }>;
  plan: BackgroundServiceRepairPlan;
  report: ServiceRepairReport;
}>;

export type ServiceRepairJsonPayload = Readonly<{
  ok: true;
  schemaVersion: 2;
  executed: boolean;
  report: ServiceRepairReport;
  daemonStatus: ServiceRepairReport['daemonStatus'];
  existingServices: BackgroundServiceRepairPlan['existingServices'];
  actions: BackgroundServiceRepairPlan['actions'];
  manualWarnings: readonly string[];
  defaultFollowingMatchesSelectedReleaseChannel: boolean;
  migration?: boolean;
  warning?: string;
  executedActions?: readonly string[];
}>;

export type BuildServiceRepairReportParams = Readonly<{
  runtime: ServiceRepairResolution['runtime'];
  plan: BackgroundServiceRepairPlan;
  warnings?: readonly HappierRuntimeWarning[];
  discoveredServices?: readonly HappierService[];
  daemonStatus?: ServiceRepairDaemonStatusSnapshot | null;
  backgroundServiceHealth?: BackgroundServiceHealthSummary | null;
  runningDaemons?: readonly RunningDaemonEntry[];
  localRelays?: readonly LocalRelayEntry[];
  authProfiles?: readonly AuthProfileEntry[];
  stacks?: readonly StackEntry[];
}>;
