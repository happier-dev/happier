export {
  classifyTailscaleServeRootSlot,
  parseTailscaleServeHttpsBaseUrlForPort,
  extractTailscaleServeHttpsUrl,
  tailscaleServeHttpsUrlForOwnedConfigFromStatus,
  tailscaleServeHttpsUrlForInternalServerUrlFromStatus,
  tailscaleServeStatusMatchesInternalServerUrl,
} from './serveStatus.js';
export type { TailscaleServeRootSlot } from './serveStatus.js';
export {
  extractTailscaleInstallerDownloadUrl,
  resolveTailscaleInstallStrategy,
  type TailscaleInstallStrategy,
} from './installStrategy.js';
export {
  extractTailscaleServeApprovalUrl,
  resolveTailscaleBin,
  runTailscaleDown,
  runTailscaleLogin,
  runTailscaleFunnelEnable,
  runTailscaleFunnelReset,
  runTailscaleFunnelStatus,
  runTailscaleServeDisable,
  runTailscaleServeEnable,
  runTailscaleServeReset,
  runTailscaleServeStatus,
  runTailscaleStatus,
  runTailscaleStatusJson,
  runTailscaleUp,
  runTailscaleVersion,
  sanitizeTailscaleEnv,
  TailscaleCommandError,
  type TailscaleCommandRequest,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
  type RunTailscaleLoginResult,
  type RunTailscaleServeEnableResult,
} from './commandRunner.js';
export {
  isTailscaleDaemonUnreachableOutput,
  parseTailscaleStatusJson,
  parseTailscaleStatusSnapshot,
  tailscaleStatusSnapshotForUnreachableDaemon,
  type TailscaleStatusSnapshot,
} from './statusSnapshot.js';
export { resolveTailscaleMachineHttpsUrlFromStatusSnapshot } from './publicUrl.js';
export {
  createTailscaleSecureAccessTaskSpec,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS,
  type TailscaleSecureAccessInstallPolicy,
  type TailscaleSecureAccessLoginPolicy,
  type TailscaleSecureAccessMode,
  type TailscaleSecureAccessProviderId,
  type TailscaleSecureAccessSystemTaskStepId,
  type TailscaleSecureAccessTaskTarget,
  type TailscaleSecureAccessTaskParams,
  type TailscaleSecureAccessTaskResult,
  type TailscaleSecureAccessTaskSpec,
} from './taskContract.js';
