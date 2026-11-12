export {
  createExecutionRunnerFromKind,
} from './createExecutionRunnerFromKind.js';
export {
  createAsyncGeneratorFromEventProducer,
} from './createAsyncGeneratorFromEventProducer.js';
export {
  SystemTaskExecutionError,
  createSystemTaskRegistry,
  executeSystemTask,
  type SystemTaskExecutionRunner,
  type SystemTaskRegistry,
  type SystemTaskRegistryEntry,
} from './runSystemTask.js';
export {
  buildPromptEventData,
  createSystemTasksRunner,
  redactSensitiveSystemTaskJsonValue,
  type InteractiveSystemTaskContext,
  type InteractiveSystemTaskEventInput,
  type InteractiveSystemTaskKind,
  type InteractiveSystemTaskKindMap,
  type InteractiveSystemTaskPromptRequest,
} from './interactiveTaskKinds.js';
export {
  buildSshTarget,
  parseSshTarget,
  type ParsedSshTarget,
} from './ssh/sshTarget.js';
export {
  buildRemoteBootstrapCommand,
  buildRemoteHappierInvocationCommand,
  type RemoteBootstrapCommandLabel,
} from './ssh/remoteBootstrapCommandBuilder.js';
export { isRemoteBootstrapUnauthenticatedCliResult, normalizeRemoteBootstrapCliJsonResult } from './executors/remoteEnrollMachineFlowExecutor.js';
export { installRemoteFirstPartyComponentPayload } from './kinds/remoteFirstPartyPayloadInstaller.js';
export { createOpenSshRemoteCliTransport } from './ssh/openSshRemoteCliTransport.js';
export { sshCommandError, sshCommandFailure } from './ssh/sshCommandFailure.js';
export { materializeSshIdentityPrivateKeyToTempFile } from './ssh/materializeSshIdentityPrivateKeyToTempFile.js';
export {
  buildRemoteSelfDownloadFirstPartyInstallCommand,
  resolveRemoteSelfDownloadFirstPartyInstallPlan,
  type RemoteSelfDownloadFirstPartyInstallPlan,
} from './ssh/remoteSelfDownloadFirstPartyInstallCommand.js';

export {
  DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
  ensureLocalFirstPartyComponentCommand,
  updateManagedLocalFirstPartyComponent,
  resolveExplicitOrInstalledLocalFirstPartyCommand,
  resolveRepoLocalFirstPartyCommandPath,
  createLocalHappierJsonExecutor,
  createHappierJsonExecutorFromTextRunner,
  resolveLocalHappierCommandTimeoutMs,
  type HappierJsonExecutor,
  type LocalFirstPartyCommandProvenance,
  type ResolvedLocalFirstPartyCommand,
  type HappierTextResult,
  type RunHappierOptions,
} from './executors/happierJsonExecutor.js';

export {
  createOpenSshHappierJsonExecutor,
  parseStrictPersonalHomeTaskFinalResult,
  type OpenSshAuth,
  type OpenSshRunRemoteText,
} from './executors/openSshHappierJsonExecutor.js';

export {
  readLocalCliUpdateFact,
  type LocalCliUpdateFact,
} from './executors/cliUpdateFact.js';

export {
  readLocalServerProfileScope,
  selectServingDaemonService,
  isInstalledDaemonServiceOfHappierHomeAndRing,
  isAppManagedDaemonService,
  readAppManagedDaemonServices,
  scopeHappierJsonExecutor,
  convergeHappierHomeServicesOntoCli,
  disconnectHappierHomeService,
  isVerifiedDaemonServiceOfHappierHome,
  readCurrentHappierServices,
  type HappierHomeServiceConvergence,
  type HappierHomeServiceDisconnect,
  type HappierServiceFollowingScope,
  type HappierServerScope,
  type LocalServerProfileScope,
} from './executors/serverScope.js';

export {
  createEnrollMachineFlowExecutorFromHappierJsonExecutor,
  serverHelpSupportsExplicitHomeSetup,
  waitForMachineOnline,
  type EnrollMachineFlowExecutorOptions,
} from './executors/enrollMachineFlowExecutor.js';

export {
  runEnrollMachineFlow,
  type EnrollMachineAuthStatus,
  type EnrollMachineDaemonStatus,
  type EnrollMachineFlowExecutor,
  type EnrollMachineFlowEvent,
  type EnrollMachineFlowResult,
  type EnrollMachineServiceAction,
  type EnrollMachineServiceCommandOptions,
  type EnrollMachineFlowStepIds,
  type EnrollMachineFlowSteps,
  type EnrollMachineRelayProfile,
} from './flows/enrollMachineFlow.js';
export {
  runRemoteHomeEnrollmentFlow,
  type RemoteHomeEnrollmentPairingRequest,
  type RemoteHomeEnrollmentResult,
} from './flows/remoteHomeEnrollmentFlow.js';
export {
  applyBackgroundServiceSetupGuidance,
  resolveBackgroundServiceSetupGuidance,
  type BackgroundServiceSetupGuidanceCancellationReason,
  type BackgroundServiceSetupGuidanceDecision,
  type BackgroundServiceSetupGuidanceFlowResult,
} from './setupServiceGuidance/applyBackgroundServiceSetupGuidance.js';
export {
  buildBackgroundServiceSetupGuidance,
  resolveBackgroundServiceSetupReconciliationDisposition,
  resolveBackgroundServiceSetupServicesRequiringReplacement,
  type BackgroundServiceSetupReconciliationAction,
  type BackgroundServiceSetupServiceTarget,
  type BackgroundServiceSetupGuidance,
  type BackgroundServiceSetupGuidanceService,
} from './setupServiceGuidance/buildBackgroundServiceSetupGuidance.js';
export {
  readBackgroundServiceSetupGuidance,
} from './setupServiceGuidance/readBackgroundServiceSetupGuidance.js';
export {
  formatBackgroundServiceManualRelayTakeoverPrompt,
  formatBackgroundServiceReleaseChannelSwitchPrompt,
  formatBackgroundServiceReplacementPrompt,
} from './setupServiceGuidance/formatBackgroundServiceSetupPrompts.js';

export * from './kinds/index.js';

export { resolveInstalledLocalFirstPartyCommand } from './executors/happierJsonExecutor.js';
