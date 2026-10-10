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
export { isRemoteBootstrapUnauthenticatedCliResult, normalizeRemoteBootstrapCliJsonResult } from './executors/remoteSetupMachineRecipeExecutor.js';
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
  createSetupMachineRecipeExecutorFromHappierJsonExecutor,
  serverHelpSupportsExplicitHomeSetup,
  type SetupMachineRecipeExecutorOptions,
} from './executors/setupMachineRecipeExecutor.js';

export {
  runSetupMachineRecipe,
  type SetupMachineAuthStatus,
  type SetupMachineDaemonStatus,
  type SetupMachineRecipeExecutor,
  type SetupMachineRecipeEvent,
  type SetupMachineRecipeResult,
  type SetupMachineServiceAction,
  type SetupMachineServiceCommandOptions,
  type SetupMachineRecipeStepIds,
  type SetupMachineRecipeSteps,
  type SetupMachineRelayProfile,
} from './recipes/setupMachineRecipe.js';
export {
  runRemoteHomeEnrollmentRecipe,
  type RemoteHomeEnrollmentPairingRequest,
  type RemoteHomeEnrollmentResult,
} from './recipes/remoteHomeEnrollmentRecipe.js';
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
