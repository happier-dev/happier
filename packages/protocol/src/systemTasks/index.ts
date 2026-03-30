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
