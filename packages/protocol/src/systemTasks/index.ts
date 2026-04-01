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
  createTailscaleSecureAccessTaskSpec,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS,
  type TailscaleSecureAccessInstallPolicy,
  type TailscaleSecureAccessLoginPolicy,
  type TailscaleSecureAccessMode,
  type TailscaleSecureAccessSystemTaskStepId,
  type TailscaleSecureAccessTaskParams,
  type TailscaleSecureAccessTaskResult,
  type TailscaleSecureAccessTaskSpec,
} from './tailscaleSecureAccessTaskContract.js';
