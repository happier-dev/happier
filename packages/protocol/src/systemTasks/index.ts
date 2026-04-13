export {
  SYSTEM_TASK_PROTOCOL_VERSION,
  SystemTaskEventSchema,
  SystemTaskJsonValueSchema,
  SystemTaskResultErrorSchema,
  SystemTaskResultSchema,
  SystemTaskSpecSchema,
  type SystemTaskEvent,
  type SystemTaskJsonArray,
  type SystemTaskJsonObject,
  type SystemTaskJsonValue,
  type SystemTaskResult,
  type SystemTaskResultError,
  type SystemTaskSpec,
} from './spec.js';

export {
  parseApproveRemoteProvisioningPromptData,
  parseReleaseChannelSwitchForSetupPromptData,
  parseReplaceLocalBackgroundServicesPromptData,
  parseReplaceRemoteBackgroundServicesPromptData,
  parseTakeOverManualRelayRuntimeForSetupPromptData,
  parseSshPasswordPromptData,
  parseSshTrustPromptData,
  type ApproveRemoteProvisioningPromptData,
  type BackgroundServicePromptEntry,
  type BackgroundServicePromptEntryWithServer,
  type ManagedReleaseChannelPromptEntry,
  type ReleaseChannelSwitchForSetupPromptData,
  type ReplaceLocalBackgroundServicesPromptData,
  type ReplaceRemoteBackgroundServicesPromptData,
  type TakeOverManualRelayRuntimeForSetupPromptData,
  type SshPasswordPromptData,
  type SshTrustPromptData,
} from './promptPayloadContracts.js';

export {
  SYSTEM_TASK_PROMPT_KINDS_V1,
  SystemTaskPromptKindSchema,
  type SystemTaskPromptKind,
} from './promptKindCatalog.js';

export {
  RELAY_CONNECT_BACKGROUND_SERVICE_SYSTEM_TASK_STEP_IDS_V1,
  REMOTE_SSH_BOOTSTRAP_MACHINE_SYSTEM_TASK_STEP_IDS_V1,
  SETUP_REPAIR_THIS_COMPUTER_SYSTEM_TASK_STEP_IDS_V1,
  SETUP_THIS_COMPUTER_SYSTEM_TASK_STEP_IDS_V1,
  RemoteSshBootstrapMachineSystemTaskStepIdSchema,
  RelayConnectBackgroundServiceSystemTaskStepIdSchema,
  SetupRepairThisComputerSystemTaskStepIdSchema,
  SetupThisComputerSystemTaskStepIdSchema,
  type RemoteSshBootstrapMachineSystemTaskStepId,
  type RelayConnectBackgroundServiceSystemTaskStepId,
  type SetupRepairThisComputerSystemTaskStepId,
  type SetupThisComputerSystemTaskStepId,
} from './stepIdCatalog.js';

export {
  createTailscaleEnsureReadyTaskSpec,
  TAILSCALE_ENSURE_READY_SYSTEM_TASK_KIND,
  TAILSCALE_ENSURE_READY_SYSTEM_TASK_STEP_IDS,
  type TailscaleEnsureReadyInstallPolicy,
  type TailscaleEnsureReadyLoginPolicy,
  type TailscaleEnsureReadyMode,
  type TailscaleEnsureReadySystemTaskStepId,
  type TailscaleEnsureReadyTaskParams,
  type TailscaleEnsureReadyTaskResult,
  type TailscaleEnsureReadyTaskSpec,
} from './tailscaleEnsureReadyTaskContract.js';

export {
  createTailscaleSecureAccessTaskSpec,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS,
  type TailscaleSecureAccessProviderId,
  type TailscaleSecureAccessInstallPolicy,
  type TailscaleSecureAccessLoginPolicy,
  type TailscaleSecureAccessMode,
  type TailscaleSecureAccessSystemTaskStepId,
  type TailscaleSecureAccessTaskTarget,
  type TailscaleSecureAccessTaskParams,
  type TailscaleSecureAccessTaskResult,
  type TailscaleSecureAccessTaskSpec,
} from './tailscaleSecureAccessTaskContract.js';
