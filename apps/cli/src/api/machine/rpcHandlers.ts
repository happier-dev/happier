import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';
import { createExecutionRunNativeOperationOwner } from '@/daemon/agentRuntime/executionRunNativeOperation';
import { randomUUID } from 'node:crypto';
import type { PreparedFilesystemTransferScope } from '@/machines/transfer/preparedFilesystemTransferScope';
import { createFilesystemEffectAdmission, type FilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { FILESYSTEM_TRANSFER_ACTION_IDS, type FilesystemTransferActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { MANAGED_MACHINE_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { SESSION_CHECKOUT_REMOVAL_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';

import { logger } from '@/ui/logger';
import { registerManagedActivityRpcHandlers, type ManagedActivityRpcOwner } from './rpcHandlers.managedActivity';
import { registerMachineWorkSummaryRpcHandlers, type MachineWorkSummaryRpcOwner } from './rpcHandlers.machineWorkSummary';
import type { NativeUsageDaemonRuntimeInput } from '@/usage/collector/nativeUsageDaemonRuntime';
import type { LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { listExecutionRunMarkersForRehydration } from '@/daemon/executionRunRegistry';
import { resolveDaemonExecutionRunBrokerAuthority } from '@/daemon/executionRunBrokerAuthority';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { readProcessCensus } from '@/processes/census/processCensus';
import { createProcessCpuSampler } from '@/processes/census/processCpu';
import { MACHINE_VITALS_LIVE_INTERVAL_MS } from '@/daemon/vitals/createMachineVitalsSampler';
import {
  StopSessionResultSchema,
  type StopSessionResult,
} from '@/daemon/sessions/stopSessionContract';
import type { StopSessionOptions } from '@/daemon/sessions/stopSession';
import type {
  DaemonExecutionRunEntry,
  DaemonExecutionRunProcessInfo,
  SpawnSessionNonceResolution,
} from '@happier-dev/protocol';
import { DaemonExecutionRunBrokerAuthorityRequestV1Schema, DaemonExecutionRunBrokerAuthorityResponseV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import { ExecutionRunPermissionRespondInputSchema } from '@happier-dev/protocol/actions/specs/executionRuns';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import {
  registerMachineVoiceSpeechRpcHandlers,
  type MachineVoiceSpeechRpcRegistration,
} from './rpcHandlers.voiceSpeech';
import {
  registerMachineVoiceClientCredentialRpcHandlers,
  type MachineVoiceClientCredentialRpcRegistration,
} from './rpcHandlers.voiceClientCredentials';
import {
  registerMachineVoiceClientCredentialAuthorizationRpcHandlers,
} from './rpcHandlers.voiceClientCredentialAuthorization';
import {
  registerMachineVoiceClientMediatedCredentialRpcHandlers,
  type MachineVoiceClientMediatedCredentialRpcRegistration,
} from './rpcHandlers.voiceClientMediatedCredentials';
import { registerMachineSpawnSessionNonceRpcHandlers } from './rpcHandlers.spawnSessionNonce';
import { registerMachineTerminalRpcHandlers, type MachineTerminalRpcRegistration, type MachineTerminalRpcHandlerDeps, type ProjectTerminalRuntime } from './rpcHandlers.terminal';
import { registerMachineAgentSignInRpcHandlers } from './rpcHandlers.agentSignIn';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import {
  registerMachineProviderRpcHandlers,
  type MachineProviderRpcServices,
} from './rpcHandlers.providers';
import {
  registerMachineExternalSessionsRpcHandlers,
  type ExternalSessionArchivedStateChange,
  type ExternalSessionDeletedChange,
} from './rpcHandlers.externalSessions';
import {
  registerMachineSessionHandoffRpcHandlers,
  type SessionHandoffDirectPeerTransferHandle,
} from './sessionHandoff/handlers';
import { registerMachineSkillsRpcHandlers } from './rpcHandlers.skills';
import {
  registerMachinePromptAssetTransferRpcHandlers,
  type MachinePromptAssetTransferRpcRegistration,
} from './rpcHandlers.promptAssetTransfers';
import { registerMachineRegistriesRpcHandlers } from './rpcHandlers.registries';
import {
  registerMachineRegistryTransferRpcHandlers,
  type MachineRegistryTransferRpcRegistration,
} from './rpcHandlers.registryTransfers';
import { registerPetRpcHandlers } from '@/pets/rpc/registerPetRpcHandlers';
import { registerMachineDirectTransferImportRpcHandlers } from './rpcHandlers.directTransferImports';
import { registerMachinePreparedTransferRpcHandlers } from './rpcHandlers.preparedTransfers';
import {
  registerMachineDirectTransferExportRpcHandlers,
  type DirectTransferExportPrepareRequest,
} from './rpcHandlers.directTransferExports';
import { registerMachineDiagnosticsRpcHandlers } from './rpcHandlers.diagnostics';
import { createMachineExecutionRunAgentStartContextResolver } from './resolveExecutionRunAgentStartContext';
import {
  registerMachineWorkspaceSyncRpcHandlers,
  type MachineWorkspaceSyncRpcService,
} from './rpcHandlers.workspaceSync';
import type { MachineSessionRpcFamily } from './rpcHandlers.sessions';
import { registerProjectOpenRpcHandlers } from '@/rpc/handlers/projects/registerProjectOpenRpcHandlers';
import type { ProjectOpenRuntime } from '@/workspaces/activation/openProject';
import { registerMachineSessionGoalRpcHandlers } from './rpcHandlers.sessionGoals';
import { registerMachineConnectedServiceQuotaRpcHandlers } from './rpcHandlers.connectedServiceQuotas';
import {
  registerMachineNpmRegistryProfileRpcHandlers,
  type NpmRegistryProfileRpcService,
} from './rpcHandlers.npmRegistryProfiles';
import { registerMachineServerWorkRpcHandlers } from './rpcHandlers.serverWork';
import type { DaemonServerWorkScheduler } from '@/daemon/serverWork';
import type {
  ExternalSessionStatusDemandChannel,
} from '@/daemon/machine/externalSessionStatusDemandBinding';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { DaemonUsageLimitRecoveryFieldMutation, DaemonWorkStateFieldMutation } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { PersistedTakeoverAdmissionWaiter } from '@/daemon/spawn/persistedTakeoverAdmission';
import type {
  ExternalSessionPersistedTakeoverAdmissionOwner,
} from '@/session/actions/externalSessions/persistedTakeoverAdmission';
import type {
  ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import type {
  ExternalSessionHostOperationInstallation,
  ExternalSessionHostOperationSet,
} from '@/session/external/hostOperationOwner';
import type {
  CancelConnectedServiceRuntimeAuthRecovery,
  CancelInactiveSessionUsageLimitRecoveryCheck,
  ReadInactiveSessionUsageLimitRecovery,
  ResumeInactiveSessionWhenUsageLimitReady,
  RetryTemporaryThrottleNow,
  ScheduleInactiveSessionUsageLimitRecoveryCheck,
} from '@/session/actions/createCliActionDeps';
import type { MachineSessionServerStartRpcRegistrationOptions } from '@/rpc/handlers/sessionServerStartMachineBinding';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { registerMachineAgentInstallJobRpcHandlers } from './rpcHandlers.agentInstallJobs';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createExecutionBudgetRegistry } from '@/daemon/executionBudget/createExecutionBudgetRegistry';
import type { ExecutionRunTeamCredentialProviderBindingPreparer } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunRequestBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { registerSessionPermissionRpcHandlers } from '@/rpc/handlers/sessionPermissions';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { MACHINE_SESSION_STOP_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { registerSubagentRpcHandlers } from '@/rpc/handlers/subagents';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';
import type { SessionLifecycleMachineDeps } from '@/session/actions/lifecycle/sessionLifecycleTypes';
import { registerTransferRelayV2DownloadSessionResponder } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import type { TransferRelayV2DownloadSessionOwner } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import type { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import { configuration } from '@/configuration';
import type { TransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import type {
  AccountPetCreateRequestV1,
  AccountPetCreateResponseV1,
  ConnectedAccountServiceKey,
  ConnectedServiceBindingsV2,
  ExternalSessionOperationSocketCommandV1,
  ExternalSessionOperationSocketResponseV1,
  ExternalSessionTranscriptInvalidationV1,
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  TransferEndpointCandidate,
  TransferRelayV2SendEnvelope,
  SessionConnectedServiceAuthSwitchRpcParams,
  SessionRunnerStatusGetRequestV1,
  SessionRunnerRuntimeStateV1,
  SessionRunnerRuntimeStatusV2,
} from '@happier-dev/protocol';
import { RestartAllSessionRunnersRequestV1Schema, RestartSessionRunnerRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { RestartSessionRunnerRequestV2Schema, RestartSessionRunnerConfirmedBackgroundRequestSchema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV2';
import { SessionRunnerStatusGetRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { SessionConnectedServiceAuthSwitchRpcParamsSchema } from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import {
  createExternalSessionOperationExclusion,
  type ExternalSessionOperationExclusionOwner,
} from '@/session/external/operationExclusion';
import type { DirectTransferImportOpenRequest } from '@/machines/transfer/directTransferImportSession';
import { createTransferSessionLifecycle } from '@happier-dev/transfers/node';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import {
  requestDaemonSessionConnectedServiceAuthSwitch,
  requestDaemonSessionRunnerRestart,
  requestDaemonSessionRunnerRestartConfirmedBackground,
  requestDaemonSessionRunnerRestartV2,
  restartAllDaemonSessionRunners,
} from '@/daemon/controlClient';
import { isUnattestedPublicV1RunnerRolloutMutation } from '@/daemon/plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import {
  registerActionOperationRpcHandlers,
  type ActionOperationRpcHandlers,
} from '@/daemon/actionOperations';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { admitSessionHandoffExistingState, type createSessionHandoffPreflightMachineRpc } from '@/session/handoff/sessionHandoffPreflightMachineRpc';
import type { StoredCredentials } from '@/persistence';
import {
  registerExternalActionRpcHandler,
  type ExternalActionRpcRegistrationOptions,
} from '@/rpc/handlers/externalAction';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { WORKFLOW_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { TerminalPtySessionManager } from '@/terminal/pty/sessions';
import { createProjectFiniteActionExecutor, registerProjectFiniteRpcHandlers } from '@/rpc/handlers/projects/registerProjectFiniteRpcHandlers';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

const transferRelayV2DownloadResponderCleanupByManager = new WeakMap<RpcHandlerManager, () => void>();
const MACHINE_RPC_HANDLER_OWNER = 'machine-rpc-surface';

function parseSessionConnectedServiceAuthSwitchRpcParams(
  raw: unknown,
): SessionConnectedServiceAuthSwitchRpcParams | null {
  const parsed = SessionConnectedServiceAuthSwitchRpcParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type MachineStopSessionHandlerResult = StopSessionResult | boolean;

function normalizeMachineStopSessionResult(result: MachineStopSessionHandlerResult): StopSessionResult {
  if (typeof result === 'boolean') {
    // Compatibility for older in-process registrars: boolean success proves only
    // request acceptance. Current daemon registrations return the strict result.
    return result ? { status: 'requested' } : { status: 'not_found' };
  }
  return StopSessionResultSchema.parse(result);
}

export type MachineRpcHandlers = {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  /**
   * Producer-owned proof for capability publication: resolved canonical
   * session-spawn replies include the atomic create-or-rejoin outcome.
   */
  sessionSpawnV1OutcomeRequired?: true;
  resolveSpawnSessionByNonce?: (spawnNonce: string, timeoutMs?: number) => Promise<SpawnSessionNonceResolution>;
  abandonSpawnSessionByNonce?: (spawnNonce: string) => Promise<
    | { status: 'completed'; sessionId: string }
    | { status: 'pending' | 'not_found' | 'unsupported' | 'failed' }
  >;
  stopSession: (sessionId: string, options?: StopSessionOptions) => Promise<MachineStopSessionHandlerResult>;
  isSessionActive?: (sessionId: string) => Promise<boolean>;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  requestShutdown: () => void;
  /** The `memory` role's worker while that role runs; external Session observation feeds it. Its RPC family is the role's. */
  memory?: Pick<MemoryWorkerHandle, 'attachExternalObservation'>;
  daemonServerWorkScheduler?: Pick<DaemonServerWorkScheduler, 'getSnapshot'>;
  machineTransferChannel?: Readonly<{
    onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
    sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
  }>;
  transferRelayV2Channel?: Readonly<{
    machineId: string;
    onEnvelope: (listener: (payload: TransferRelayV2SendEnvelope) => void) => () => void;
    sendEnvelope: (payload: TransferRelayV2SendEnvelope) => void;
  }>;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  directTransferImport?: Readonly<{
    prepareImportSession: (input: DirectTransferImportOpenRequest, filesystemScope?: PreparedFilesystemTransferScope) => Promise<Readonly<{
      uploadId: string;
      destDisplayPath: string;
      expectedSizeBytes: number;
      chunkSizeBytes: number;
      recipientPublicKeyBase64: string;
      expiresAt: number;
      endpointCandidates: readonly TransferEndpointCandidate[];
    }>>;
    abortImportSession: (
      input: Readonly<{ uploadId: string }>,
      filesystemScope?: PreparedFilesystemTransferScope | null,
    ) => Promise<void | Readonly<{ aborted: boolean }>>;
  }>;
  preparedMachineTransfer?: Pick<Parameters<typeof registerMachinePreparedTransferRpcHandlers>[0], 'request' | 'rawTransferHandlers'>;
  directTransferExport?: Readonly<{
    prepareExportSession: (input: DirectTransferExportPrepareRequest, filesystemScope?: PreparedFilesystemTransferScope, context?: RpcHandlerContext) => Promise<Readonly<{
      transferId: string;
      endpointCandidates: readonly TransferEndpointCandidate[];
      expiresAt: number;
    }>>;
    releaseExportSession?: (transferId: string, filesystemScope?: PreparedFilesystemTransferScope | null) => Promise<void> | void;
  }>;
};

export type MachineRpcHandlerDeps = Readonly<{
  filesystemEffectAdmission?: FilesystemEffectAdmission;
  createFilesystemTransferScope?: (rootPath: string, context?: RpcHandlerContext) => PreparedFilesystemTransferScope;
  mcpServers?: Parameters<typeof registerMachineMcpServersRpcHandlers>[0]['deps'];
  readSpawnFailureLimits?: MachineTerminalRpcHandlerDeps['readSpawnFailureLimits'];
  ownerRemainder?: MachineTerminalRpcHandlerDeps['ownerRemainder'];
  agentIsolation?: MachineTerminalRpcHandlerDeps['agentIsolation'];
  nativeOperationRuntime?: MachineTerminalRpcHandlerDeps['nativeOperationRuntime'] & Partial<Pick<import('@/api/apiMachine').ApiMachineClient, 'readMemberFolderOwner'>>;
  resolveHostHomeServerIdentityId?: MachineTerminalRpcHandlerDeps['resolveHostHomeServerIdentityId'];
  readSignInConnectedDefaultSelection?: NonNullable<Parameters<typeof registerMachineAgentSignInRpcHandlers>[0]['deps']>['readSignInConnectedDefaultSelection'];
  readMachineEffectiveCores?: () => number | undefined;
  requesterSessionRuntime?: NonNullable<Parameters<typeof import('@/rpc/handlers/sessionLifecycle').registerSessionLifecycleRpcHandlers>[0]['requesterSessionRuntime']>;
  requesterBootstrapBoundary?: NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['requesterBootstrapBoundary']>;
  prepareManagedSessionHandoffDirectoryPlacement?: NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['prepareManagedDirectoryPlacement']>;
  accountReadRuntime?: MachineTerminalRpcHandlerDeps['accountReadRuntime'];
  managedActivity?: ManagedActivityRpcOwner;
  machineWorkSummary?: MachineWorkSummaryRpcOwner;
  nativeUsage?: Omit<NativeUsageDaemonRuntimeInput, 'observation' | 'budgetRegistry'>;
  executionBudgetRegistry?: ReturnType<typeof createExecutionBudgetRegistry>;
  readRequesterNativeOfferedModel?: Parameters<typeof registerExecutionRunHandlers>[1]['readRequesterNativeOfferedModel'];
  /** Exact installed daemon owners plus current authenticated requester material. */
  createProjectFiniteRuntime?: (ports: Readonly<{
    operationRuntime: ProjectTerminalRuntime['operationRuntime'];
    terminalSessions: TerminalPtySessionManager;
  }>, ingress: RpcHandlerContext) => Promise<ProjectTerminalRuntime | null>;
  beforeProjectFiniteRetire?: () => Promise<void>;
  sessionRunnerStatus?: Readonly<{
    get: (request: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStateV1>;
    getV2: (request: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStatusV2>;
  }>;
  actionOperations?: Readonly<{
    store?: Pick<HostActionOperationRuntime['store'], 'get'>
      & Partial<Pick<HostActionOperationRuntime['store'], 'readActiveProjectCommands'>>;
    runner?: ProjectTerminalRuntime['operationRuntime']['runner'];
    attachOwner?: import('@/daemon/actionOperations/createHostActionOperationRuntime').HostActionOperationRuntime['attachOwner'];
    handlers: ActionOperationRpcHandlers;
    observeExecution: HostActionOperationRuntime['observeExecution'];
    decideSetupReview: HostActionOperationRuntime['decideSetupReview'];
    waitForProjectTerminalAttachment?: HostActionOperationRuntime['waitForProjectTerminalAttachment'];
    retireProjectFiniteOperations?: HostActionOperationRuntime['retireProjectFiniteOperations'];
  }>;
  sessionHandoffCoordinator?: NonNullable<
    Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['coordinateSessionHandoff']
  >;
  sessionHandoffPreflight?: Readonly<{
    readCredentials: () => Promise<StoredCredentials | null>;
    callMachine: ReturnType<typeof createSessionHandoffPreflightMachineRpc>;
  }>;
  resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  workspaceSync?: MachineWorkspaceSyncRpcService;
  /** Passive Project setup producer plus authenticated Account row composition. */
  projectOpen?: ProjectOpenRuntime;
  /**
   * Host-private server-origin Session-start binding. The session RPC owner
   * supplies its lifecycle and nonce handlers at registration time.
   */
  sessionServerStart?: Omit<
    MachineSessionServerStartRpcRegistrationOptions,
    'spawnLifecycleHandler' | 'resolveSpawnSessionByNonce'
  >;
  sessionCreationInstallation?: MachineSessionServerStartRpcRegistrationOptions['sessionCreationInstallation'];
  /** Closed server-origin Action receiver bound to the shared daemon ingress. */
  externalAction?: ExternalActionRpcRegistrationOptions;
  externalSessionOperationExclusion?: ExternalSessionOperationExclusionOwner;
  npmRegistryProfiles?: Readonly<{
    machineId: string;
    service: NpmRegistryProfileRpcService;
  }>;
  providerRpc?: Readonly<{
    machineId: string;
    services: MachineProviderRpcServices;
    featureGate: Readonly<{ isEnabled(featureId: 'providers'): boolean }>;
  }>;
  agentCatalogObservation?: AgentProviderCatalogObservationService;
  secretSources?: NonNullable<Parameters<typeof registerCapabilitiesHandlers>[1]>['secretSources'];
  savedSecretOperationContext?: NonNullable<Parameters<typeof registerCapabilitiesHandlers>[1]>['savedSecretOperationContext'];
  createCapabilitiesApiClient?: NonNullable<
    Parameters<typeof registerCapabilitiesHandlers>[1]
  >['createApiClient'];
  activateCapabilitiesPurposeBindings?: NonNullable<
    Parameters<typeof registerCapabilitiesHandlers>[1]
  >['activatePurposeBindings'];
  observeCapabilitiesCliSnapshot?: NonNullable<
    Parameters<typeof registerCapabilitiesHandlers>[1]
  >['observeCliSnapshot'];
  runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  resolveExecutionSurfaces?: SessionLifecycleMachineDeps['resolveExecutionSurfaces'];
  awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
  /** New Session intent on this Machine: prepare for the Session (session host) until `signal` aborts. */
  prestartSessionHost?: (signal: AbortSignal) => Promise<void>;
  createRegistryHost?: (signal?:AbortSignal,context?:RpcHandlerContext)=>ReturnType<typeof createCliRegistryHostV1>;
  workingDirectory?: string;
  filesystemAccessPolicy?: FilesystemAccessPolicy;
  terminalRegistry?: TerminalProcessRegistry;
  getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
  transientMediaReadAllowance?: TransientSessionMediaReadAllowance;
  extraTransferRelayV2DownloadOwners?: readonly TransferRelayV2DownloadSessionOwner[];
  emitExternalSessionTranscriptUpdate?: (payload: ExternalSessionTranscriptInvalidationV1) => void | Promise<void>;
  emitExternalSessionSourceUnavailableOccurrence?: (payload: import('@happier-dev/protocol').ExternalSessionSourceUnavailableOccurrenceV1) => void | Promise<void>;
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  executeExternalSessionHistoricalImportCommand?: (
    command: ExternalSessionOperationSocketCommandV1,
  ) => Promise<ExternalSessionOperationSocketResponseV1>;
  persistedTakeoverAdmissionWaiter?: PersistedTakeoverAdmissionWaiter;
  attachPersistedTakeoverAdmissionOwner?: (
    owner: ExternalSessionPersistedTakeoverAdmissionOwner,
  ) => () => void;
  installExternalSessionHostOperations?: (
    operations: ExternalSessionHostOperationSet,
  ) => Promise<ExternalSessionHostOperationInstallation>;
  readMaterializedStateObservationBinding?: Parameters<
    typeof registerMachineExternalSessionsRpcHandlers
  >[0]['readMaterializedStateObservationBinding'];
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  readInactiveSessionUsageLimitRecovery?: ReadInactiveSessionUsageLimitRecovery;
  cancelConnectedServiceRuntimeAuthRecovery?: CancelConnectedServiceRuntimeAuthRecovery;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
  currentMachineId?: string;
  /** Authenticated Home at this Machine RPC receiver, never a request-body selector. */
  currentServerId?: string;
  executionRunRuntimeAccountId?: string;
  openAccountConnectionManagedConsumerSource?: import('@/agent/runtime/bridges/executionRun/runtime/managedProvider').ExecutionRunManagedProviderSourceOpener;
  resolveManagedPurposeBindingIntent?: import('@/providers/managed/resolvePurposeBindingSnapshot').ResolveManagedProviderPurposeBindingIntent;
  /** Invocation-owned Settings from this daemon's captured Home and authenticated Account. */
  executionRunAccountSettings?: Readonly<{
    serverUrl: string;
    resolveAccountSettings: NonNullable<Parameters<typeof registerExecutionRunHandlers>[1]['resolveAccountSettings']>;
    resolveAccountSettingsSnapshot: NonNullable<Parameters<typeof registerExecutionRunHandlers>[1]['resolveAccountSettingsSnapshot']>;
    resolveManagedPurposeBindingIntent?: Parameters<typeof registerExecutionRunHandlers>[1]['resolveManagedPurposeBindingIntent'];
    readModelProjection?: Parameters<typeof registerExecutionRunHandlers>[1]['readModelProjection'];
    prepareManagedEndpoint?: Parameters<typeof registerExecutionRunHandlers>[1]['prepareManagedEndpoint'];
    actionsSettingsProvider: RuntimeActionSettingsProvider;
  }>;
  /** Review transport bound to this daemon's exact authenticated Home credentials. */
  executionRunApprovalDeps?: Parameters<typeof registerExecutionRunHandlers>[1]['actionApprovalDeps'];
  /** Daemon-owned exact Team binding opener for detached explicit Runs. */
  prepareRunTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
  /** Routes marker-located requests into the exact live Session runtime owner. */
  resolveExecutionRunLiveBrokerAuthority?: (
    input: Readonly<{
      sessionId: string;
      requestingAccountId: string;
      executionRunId: string;
      expectedIntent?: import('@happier-dev/protocol').ExecutionRunIntent;
      expectedOccurrenceId: string | null;
      expectedDirectMaterialUse?: import('@happier-dev/protocol/teams').TeamCredentialDirectMaterialUseV1;
    }>,
  ) => Promise<import('@happier-dev/protocol').SessionExecutionRunBrokerAuthorityResponseV1>;
  /** Exact authenticated Account policy shared with detached execution-run Actions. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  externalSessionStatusDemandChannel?: ExternalSessionStatusDemandChannel;
  subscribeSessionArchivedStateChanges?: (
    listener: (
      change: ExternalSessionArchivedStateChange,
    ) => void | Promise<void>,
  ) => () => void;
  subscribeSessionDeletedChanges?: (
    listener: (change: ExternalSessionDeletedChange) => void | Promise<void>,
  ) => () => void;
  subscribeConnectedAccountInvalidations?: (listener: () => void) => () => void;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  stageUsageLimitRecoveryMutation?: (input: Readonly<{
    mutation: DaemonUsageLimitRecoveryFieldMutation;
    rawSession: RawSessionRecord;
  }>) => Promise<void>;
  stageWorkStateMutation?: (input: Readonly<{
    mutation: DaemonWorkStateFieldMutation;
    rawSession: RawSessionRecord;
    signal?: AbortSignal;
  }>) => Promise<void>;
}>;

export type MachineRpcLifecycleRegistration = Readonly<{
  isSessionActive?: MachineRpcHandlers['isSessionActive'];
  probeInactiveUsageLimitRecovery: ReturnType<typeof registerMachineSessionGoalRpcHandlers>['probeInactiveUsageLimitRecovery'];
  /** Closed custodian work consumes the same capability service without requester ingress. */
  hostCapabilities: ReturnType<typeof registerCapabilitiesHandlers>;
  captureExecutionRunWorkflowRequester?: ExecutionRunHostBridge['captureWorkflowRequester'];
  captureExecutionRunResumeMaterialization?: ExecutionRunHostBridge['captureResumeMaterialization'];
  /** Close this ingress occurrence while retaining observation until actual finite settlement. */
  retireFiniteExecution(): Promise<void>;
  liveWorkProducers?: readonly LiveWorkProducerV1[];
  cleanupRequesterMachineTerminals: MachineTerminalRpcRegistration['cleanupRequesterMachineTerminals'];
  getFiniteTerminalSessions: MachineTerminalRpcRegistration['getSessionManager'];
  readActiveProjectCommands?: import('@/daemon/actionOperations/actionOperationStore').ActionOperationStore['readActiveProjectCommands'];
  projectFiniteExecutionInstalled: boolean;
  /** The same installed PTY/operation factory consumed by finite and Service effects. */
  resolveProjectFiniteRuntime?: (ingress: RpcHandlerContext) => Promise<ProjectFiniteActionRuntime | null>;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  /** The one fenced external-session executor retained for host Action ingress. */
  externalSessionHostActionExecutor?: RpcActionExecutor;
  /**
   * Inputs of the new-Session RPC family. The `sessions` Machine role registers it on activation
   * (P03-SESSIONS-SPLIT); machine core registers none of its methods.
   */
  sessionsRoleFamily: MachineSessionRpcFamily;
  connectivityResources: readonly Readonly<{
    name: string;
    pause(): void | Promise<void>;
    resume(): void | Promise<void>;
  }>[];
  transferRelayV2DownloadOwners: readonly TransferRelayV2DownloadSessionOwner[];
  promptAssetTransfers: MachinePromptAssetTransferRpcRegistration;
  registryTransfers: MachineRegistryTransferRpcRegistration;
  voiceSpeech: MachineVoiceSpeechRpcRegistration;
  voiceClientCredentials: MachineVoiceClientCredentialRpcRegistration;
  voiceClientMediatedCredentials: MachineVoiceClientMediatedCredentialRpcRegistration;
  dispose: () => Promise<void>;
}>;

export function registerMachineRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>): MachineRpcLifecycleRegistration {
  if (typeof params.rpcHandlerManager.replaceOwnedHandlers === 'function') {
    return params.rpcHandlerManager.replaceOwnedHandlers(
      MACHINE_RPC_HANDLER_OWNER,
      () => registerMachineRpcHandlersOnce(params),
    );
  }
  return registerMachineRpcHandlersOnce(params);
}

function registerMachineRpcHandlersOnce(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>): MachineRpcLifecycleRegistration {
  const { rpcHandlerManager, handlers } = params;
  const filesystemEffectAdmission = params.deps?.filesystemEffectAdmission
    ?? createFilesystemEffectAdmission({ resolveHostIdentity: async () => null });
  if (handlers.preparedMachineTransfer) registerMachinePreparedTransferRpcHandlers({ rpcHandlerManager, ...handlers.preparedMachineTransfer });
  transferRelayV2DownloadResponderCleanupByManager.get(rpcHandlerManager)?.();
  transferRelayV2DownloadResponderCleanupByManager.delete(rpcHandlerManager);
  const { spawnSession, stopSession, requestShutdown } = handlers;
  if (params.deps?.machineWorkSummary) registerMachineWorkSummaryRpcHandlers({ rpcHandlerManager, ...params.deps.machineWorkSummary });
  if (params.deps?.managedActivity) registerManagedActivityRpcHandlers({
    rpcHandlerManager, ...params.deps.managedActivity,
  });
  const memoryWorker = handlers.memory ?? null;
  const externalSessionOperationExclusion =
    params.deps?.externalSessionOperationExclusion
    ?? createExternalSessionOperationExclusion({
      activeServerDir: configuration.activeServerDir,
      ownerId: `cli-daemon:${process.pid}:session-operations:${randomUUID()}`,
    });
  let transferRelayV2ResponderCleanup: (() => void) | null = null;

  if (params.deps?.actionOperations) {
    registerActionOperationRpcHandlers(rpcHandlerManager, params.deps.actionOperations.handlers);
  }
  registerMachineWorkspaceSyncRpcHandlers({
    rpcHandlerManager,
    ...(params.deps?.workspaceSync ? { service: params.deps.workspaceSync } : {}),
    ...(params.deps?.actionOperations
      ? { observeExecution: params.deps.actionOperations.observeExecution }
      : {}),
  });

  registerProjectOpenRpcHandlers(rpcHandlerManager, {
    serverId: params.deps?.currentServerId ?? configuration.activeServerId,
    machineId: params.deps?.currentMachineId ?? '',
    ...(params.deps?.actionOperations ? { observeExecution: params.deps.actionOperations.observeExecution } : {}),
    ...(params.deps?.projectOpen ? { runtime: params.deps.projectOpen } : {}),
    ...(params.deps?.requesterSessionRuntime ? { requesterSessionRuntime: params.deps.requesterSessionRuntime } : {}),
    ...(params.deps?.requesterBootstrapBoundary ? { requesterBootstrapBoundary: params.deps.requesterBootstrapBoundary } : {}),
  });

  const sessionsRoleFamily: MachineSessionRpcFamily = { handlers, deps: { ...params.deps, filesystemEffectAdmission } };
  const externalAction = params.deps?.externalAction;
  if (externalAction) {
    registerExternalActionRpcHandler(rpcHandlerManager, externalAction);
    registerActionSpecRpcHandlers({
      rpcHandlerManager,
      actionIds: [...WORKFLOW_ACTION_IDS_V1, ...MANAGED_MACHINE_ACTION_IDS_V1, 'machines.setup.apply', 'notifications.notify_me', 'action.options.resolve', 'action.invoke',
        'projects.worker.status', 'projects.worker.copy.retire'],
      ...(params.deps?.currentMachineId
        ? { targetMachineId: params.deps.currentMachineId }
        : {}),
      ...(params.deps?.actionOperations ? { observeExecution: params.deps.actionOperations.observeExecution } : {}),
      actionExecutor: {
        execute: async (actionId, input, context) => await externalAction.executor.execute(
          actionId as Parameters<typeof externalAction.executor.execute>[0],
          input,
          context,
        ),
      },
    });
  }
  const { probeInactiveUsageLimitRecovery } = registerMachineSessionGoalRpcHandlers({
    rpcHandlerManager,
    deps: {
      resumeInactiveSessionWhenUsageLimitReady: params.deps?.resumeInactiveSessionWhenUsageLimitReady,
      scheduleInactiveSessionUsageLimitRecoveryCheck: params.deps?.scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck: params.deps?.cancelInactiveSessionUsageLimitRecoveryCheck,
      readInactiveSessionUsageLimitRecovery: params.deps?.readInactiveSessionUsageLimitRecovery,
      cancelConnectedServiceRuntimeAuthRecovery: params.deps?.cancelConnectedServiceRuntimeAuthRecovery,
      retryTemporaryThrottleNow: params.deps?.retryTemporaryThrottleNow,
      currentMachineId: params.deps?.currentMachineId,
      ...(params.deps?.currentMachineId ? { machineActionDirectTargetTransport: {
        machineId: params.deps.currentMachineId,
        invoke: (method, request, options) => rpcHandlerManager.invokeLocal(method, request, options),
      } } : {}),
      stageUsageLimitRecoveryMutation: params.deps?.stageUsageLimitRecoveryMutation,
      stageWorkStateMutation: params.deps?.stageWorkStateMutation,
    },
  });
  registerMachineConnectedServiceQuotaRpcHandlers({ rpcHandlerManager });
  // Replay consumes the same installed owner that admitted the original Action,
  // including its native effects and origin currentness. A credential-only
  // executor would re-enter Machine admission instead of consuming that custody.
  registerApprovalRpcHandlers({ rpcHandlerManager,
    ...(externalAction ? { actionExecutor: {
      execute: (actionId, input, context) => externalAction.executor.execute(
        actionId as Parameters<typeof externalAction.executor.execute>[0], input, context),
      replayApprovedApprovalRequest: externalAction.executor.replayApprovedApprovalRequest,
      continueConfidentialApprovalRequest: externalAction.executor.continueConfidentialApprovalRequest,
    } } : {}),
  });
  // Detached execution runs are owned by this exact authenticated daemon. Reuse
  // the incumbent execution-run bridge/action family with its nullable scope;
  // no Admin target picker, Session projection, or parallel daemon registry.
  const hostCapabilities = registerCapabilitiesHandlers(rpcHandlerManager, {
    warmOnRegister: true,
    ...(params.deps?.secretSources ? { secretSources: params.deps.secretSources } : {}),
    ...(params.deps?.savedSecretOperationContext ? { savedSecretOperationContext: params.deps.savedSecretOperationContext } : {}),
    filesystemEffectAdmission,
    ...(params.deps?.observeCapabilitiesCliSnapshot
      ? { observeCliSnapshot: params.deps.observeCapabilitiesCliSnapshot }
      : {}),
    hasSessionAgentTransition: () => externalAction !== undefined,
    ...(params.deps?.createCapabilitiesApiClient
      ? { createApiClient: params.deps.createCapabilitiesApiClient }
      : {}),
    ...(params.deps?.activateCapabilitiesPurposeBindings
      ? { activatePurposeBindings: params.deps.activateCapabilitiesPurposeBindings }
      : {}),
  });
  registerMachineAgentInstallJobRpcHandlers({ rpcHandlerManager, deps: {
    agentIsolation: params.deps?.agentIsolation,
    nativeOperationRuntime: params.deps?.nativeOperationRuntime,
    resolveHostHomeServerIdentityId: params.deps?.resolveHostHomeServerIdentityId,
  } });
  let detachedExecutionRunManager: ExecutionRunRequestBridgeContract<ExecutionRunHostBridge> | null = null;
  const executionBudgetRegistry = params.deps?.executionBudgetRegistry ?? createExecutionBudgetRegistry();
  let sessionDelete: Parameters<typeof registerExecutionRunHandlers>[1]['sessionDelete'];
  if (externalAction && params.deps?.currentMachineId) {
    registerSessionLifecycleRpcHandlers({
      rpcHandlerManager: { registerHandler: (_method, handler) => { sessionDelete = handler; } },
      actionIds: SESSION_CHECKOUT_REMOVAL_ACTION_IDS_V1,
      scopes: [{ id: 'session.delete', methods: [SESSION_RPC_METHODS.SESSION_DELETE] }],
      targetMachineId: params.deps.currentMachineId, defaultMachineTarget: true,
      actionExecutor: { execute: (actionId, input, context) => externalAction.executor.execute(
        actionId as Parameters<typeof externalAction.executor.execute>[0], input, context) },
      ...(params.deps.actionOperations ? { observeExecution: params.deps.actionOperations.observeExecution } : {}),
      ...(params.deps.requesterSessionRuntime ? { requesterSessionRuntime: params.deps.requesterSessionRuntime } : {}),
      ...(params.deps.requesterBootstrapBoundary ? { requesterBootstrapBoundary: params.deps.requesterBootstrapBoundary } : {}),
    });
  }
  const executionRunRegistration = registerExecutionRunHandlers(rpcHandlerManager, {
    sessionId: null,
    ...(sessionDelete ? { sessionDelete } : {}),
    ...(params.deps?.actionOperations?.attachOwner ? { attachActionOperationOwner: params.deps.actionOperations.attachOwner } : {}),
    budgetRegistry: executionBudgetRegistry,
    ...(params.deps?.readRequesterNativeOfferedModel
      ? { readRequesterNativeOfferedModel: params.deps.readRequesterNativeOfferedModel }
      : {}),
    serverId: params.deps?.currentServerId ?? configuration.activeServerId,
    ...(params.deps?.executionRunRuntimeAccountId
      ? { runtimeAccountId: params.deps.executionRunRuntimeAccountId }
      : {}),
    cwd: params.deps?.workingDirectory ?? process.cwd(),
    resolveProjectLaunchContext: async context => {
      if (!context.signal || !resolveProjectFiniteRuntime || !context.requesterSessionBootstrap && !context.callerInputAuthorization) return null;
      const ingress: RpcHandlerContext = { ...context, signal: context.signal, callerAuthority: context.authority,
        localActionContext: { ...context } };
      const operation = context.operationProgress && context.operationOwnerUpdate ? {
        signal: context.signal, actionRequestId: context.actionRequestId ?? undefined,
        operationProgress: context.operationProgress, operationOwnerUpdate: context.operationOwnerUpdate,
        ...(context.operationAcceptance ? { operationAcceptance: context.operationAcceptance } : {}),
        ...(context.operationCancellation ? { operationCancellation: context.operationCancellation } : {}),
        ...(context.operationReview ? { operationReview: context.operationReview } : {}),
      } : undefined;
      const nativeRuntime = params.deps?.nativeOperationRuntime;
      const agentIsolation = params.deps?.agentIsolation;
      const nativeOwner = nativeRuntime?.readMemberFolderOwner && agentIsolation
        ? createExecutionRunNativeOperationOwner({ machine: { prepareNativeOperation: nativeRuntime.prepareNativeOperation,
          readMemberFolderOwner: nativeRuntime.readMemberFolderOwner }, agentIsolation, ingress,
          resolveRequesterIdentity: async () => {
            const home = await params.deps?.resolveHostHomeServerIdentityId?.(context.signal);
            return selectHostRequesterExecutionIdentity({ rpcContext: ingress, hostHomeServerIdentityId: home });
          } }) : undefined;
      return { ingress, ...(nativeOwner ?? {}), ...(operation ? { operation } : {}),
        ...(context.requesterSessionBootstrap ? { requester: { bootstrap: context.requesterSessionBootstrap,
          isCurrent: context.requesterSessionBootstrap.isCurrent } } : {}),
        isCurrent: async () => !context.signal!.aborted && (!context.verifyMachineAdmissionCurrent || await context.verifyMachineAdmissionCurrent()),
        resolveRuntime: resolveProjectFiniteRuntime };
    },
    ...(params.deps?.currentMachineId ? { machineId: params.deps.currentMachineId } : {}),
    ...(params.deps?.getServerFeaturesSnapshot
      ? { getServerFeaturesSnapshot: params.deps.getServerFeaturesSnapshot }
      : {}),
    ...(params.deps?.actionsSettingsProvider
      ? { actionsSettingsProvider: params.deps.actionsSettingsProvider }
      : {}),
    ...(params.deps?.executionRunAccountSettings ?? {}),
    resolveAgentStartContext: createMachineExecutionRunAgentStartContextResolver({
      machineId: params.deps?.currentMachineId, cwd: params.deps?.workingDirectory ?? process.cwd(),
    }),
    ...(params.deps?.prepareRunTeamCredentialProviderBinding
      ? { prepareRunTeamCredentialProviderBinding: params.deps.prepareRunTeamCredentialProviderBinding }
      : {}),
    parentProvider: 'daemon.executionRuns',
    ...(params.deps?.executionRunApprovalDeps ? { actionApprovalDeps: params.deps.executionRunApprovalDeps } : {}),
    sendAcp: async () => {},
    onManagerCreated: (manager) => {
      detachedExecutionRunManager = manager;
    },
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND, async (raw: unknown, context) => {
    if (context?.callerAuthority !== 'present_user') {
      return { ok: false, errorCode: 'present_user_required', error: 'Present-user authority required' };
    }
    const parsed = ExecutionRunPermissionRespondInputSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid params' };
    }
    const { runId, ...response } = parsed.data;
    if (!detachedExecutionRunManager) {
      return { ok: false, errorCode: 'execution_run_target_unavailable', error: 'Execution-run target unavailable' };
    }
    const run = await detachedExecutionRunManager.getForRequest(runId, null,
      projectRpcRequesterWorkAttribution(context, params.deps?.currentServerId ?? configuration.activeServerId));
    if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Execution run not found' };
    return await detachedExecutionRunManager.completePermissionRequest(runId, response);
  });
  registerSessionPermissionRpcHandlers({ rpcHandlerManager });
  registerSubagentRpcHandlers({ rpcHandlerManager });

  if (handlers.daemonServerWorkScheduler) {
    registerMachineServerWorkRpcHandlers({
      rpcHandlerManager,
      daemonServerWorkScheduler: handlers.daemonServerWorkScheduler,
    });
  }

  const voiceSpeechRegistration = registerMachineVoiceSpeechRpcHandlers({
    rpcHandlerManager,
    machineId: params.deps?.currentMachineId ?? params.deps?.providerRpc?.machineId ?? null,
  });
  const voiceClientCredentialRegistration = registerMachineVoiceClientCredentialRpcHandlers({
    rpcHandlerManager,
    machineId: params.deps?.currentMachineId ?? params.deps?.providerRpc?.machineId ?? null,
  });
  const voiceClientMediatedCredentialRegistration =
    registerMachineVoiceClientMediatedCredentialRpcHandlers({ rpcHandlerManager });
  registerMachineVoiceClientCredentialAuthorizationRpcHandlers({
    rpcHandlerManager,
    machineId: params.deps?.currentMachineId ?? params.deps?.providerRpc?.machineId ?? null,
  });

  registerMachineAgentSignInRpcHandlers({ rpcHandlerManager, deps: params.deps });
  const operationRuntime = params.deps?.actionOperations;
  const operationStore = operationRuntime?.store;
  const operationRunner = operationRuntime?.runner;
  const createProjectFiniteRuntime = params.deps?.createProjectFiniteRuntime;
  let projectFiniteIngressClosed = false;
  const resolveProjectFiniteRuntime = createProjectFiniteRuntime && operationStore
    && operationRuntime?.waitForProjectTerminalAttachment && operationRuntime.retireProjectFiniteOperations && operationRunner
    ? async (ingress: RpcHandlerContext) => {
      if (projectFiniteIngressClosed) {
        logger.debug('[ProjectFinite] Runtime resolution refused', { reason: 'finite_ingress_retired',
          ...(ingress.requesterSessionBootstrap?.getBoundSessionId()
            ? { sessionId: ingress.requesterSessionBootstrap.getBoundSessionId() } : {}) });
        return null;
      }
      const runtime = await createProjectFiniteRuntime({
        operationRuntime: { observeExecution: operationRuntime.observeExecution,
          decideSetupReview: operationRuntime.decideSetupReview,
          store: operationStore,
          ...(operationRuntime.attachOwner ? { attachOwner: operationRuntime.attachOwner } : {}),
          runner: operationRunner,
          waitForProjectTerminalAttachment: operationRuntime.waitForProjectTerminalAttachment! },
        terminalSessions: terminalRegistration.getSessionManager(),
      }, ingress);
      if (projectFiniteIngressClosed) {
        logger.debug('[ProjectFinite] Runtime resolution refused', { reason: 'finite_ingress_retired',
          ...(ingress.requesterSessionBootstrap?.getBoundSessionId()
            ? { sessionId: ingress.requesterSessionBootstrap.getBoundSessionId() } : {}) });
        return null;
      }
      if (!runtime) return null;
      const resolveHome = params.deps?.resolveHostHomeServerIdentityId ?? runtime.resolveHostHomeServerIdentityId;
      const hostHomeServerIdentityId = resolveHome
        ? await resolveHome(ingress.signal) : await resolveServerProfileHomeIdentityId(runtime.serverId);
      return { ...runtime,
        requesterIdentity: selectHostRequesterExecutionIdentity({ rpcContext: ingress, hostHomeServerIdentityId }),
        resolveHostHomeServerIdentityId: async () => hostHomeServerIdentityId,
        ...(params.deps?.nativeOperationRuntime ? { nativeOperationRuntime: params.deps.nativeOperationRuntime } : {}),
        isCurrent: async () => !projectFiniteIngressClosed
        && (!runtime.isCurrent || await runtime.isCurrent()) };
    }
    : undefined;
  const createProjectActionExecutor = (runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext) =>
    createProjectFiniteActionExecutor(runtime, ingress, params.deps?.actionsSettingsProvider);
  const terminalRegistration = registerMachineTerminalRpcHandlers({
    rpcHandlerManager,
    deps: {
      readSpawnFailureLimits: params.deps?.readSpawnFailureLimits,
      ownerRemainder: params.deps?.ownerRemainder,
      agentIsolation: params.deps?.agentIsolation,
      nativeOperationRuntime: params.deps?.nativeOperationRuntime,
      resolveHostHomeServerIdentityId: params.deps?.resolveHostHomeServerIdentityId,
      serverId: params.deps?.currentServerId,
      ...(operationRuntime ? { operationRuntime } : {}),
      workingDirectory: params.deps?.workingDirectory,
      accessPolicy: params.deps?.filesystemAccessPolicy,
      ...(params.deps?.managedActivity ? { admissionDrain: params.deps.managedActivity.admissionDrain } : {}),
      ...(params.deps?.accountReadRuntime ? { accountReadRuntime: params.deps.accountReadRuntime } : {}),
      ...(params.deps?.terminalRegistry ? { terminalRegistry: params.deps.terminalRegistry } : {}),
      ...(resolveProjectFiniteRuntime ? {
        projectFiniteRuntime: resolveProjectFiniteRuntime,
        projectScriptExecutor: createProjectActionExecutor,
      } : {}),
    },
  });
  if (resolveProjectFiniteRuntime && params.deps?.currentMachineId && params.deps.currentServerId) {
    registerProjectFiniteRpcHandlers(rpcHandlerManager, {
      machineId: params.deps.currentMachineId, serverId: params.deps.currentServerId,
      runtime: resolveProjectFiniteRuntime,
      createActionExecutor: createProjectActionExecutor,
    });
  }
  let finiteRetirement: Promise<void> | null = null;
  const retireFiniteExecution = (): Promise<void> => {
    projectFiniteIngressClosed = true;
    if (finiteRetirement) return finiteRetirement;
    finiteRetirement = (async () => {
      if (!resolveProjectFiniteRuntime) return;
      await params.deps?.beforeProjectFiniteRetire?.();
      await operationRuntime!.retireProjectFiniteOperations!();
    })();
    return finiteRetirement;
  };
  registerMachineMcpServersRpcHandlers({ rpcHandlerManager, deps: { ...params.deps?.mcpServers,
    ...(params.deps?.agentIsolation ? { agentIsolation: params.deps.agentIsolation } : {}),
    resolveHostHomeServerIdentityId: params.deps?.resolveHostHomeServerIdentityId
      ?? params.deps?.mcpServers?.resolveHostHomeServerIdentityId,
  } });
  if (params.deps?.providerRpc) {
    registerMachineProviderRpcHandlers({
      rpcHandlerManager,
      machineId: params.deps.providerRpc.machineId,
      services: params.deps.providerRpc.services,
      featureGate: params.deps.providerRpc.featureGate,
    });
  }
  if (params.deps?.npmRegistryProfiles) {
    registerMachineNpmRegistryProfileRpcHandlers({
      rpcHandlerManager,
      machineId: params.deps.npmRegistryProfiles.machineId,
      service: params.deps.npmRegistryProfiles.service,
    });
  }
  registerMachineSkillsRpcHandlers({ rpcHandlerManager,
    ...(externalAction ? { actionExecutor: externalAction.executor } : {}),
  });
  const promptAssetTransfers = registerMachinePromptAssetTransferRpcHandlers({
    rpcHandlerManager,
  });
  registerMachineRegistriesRpcHandlers({rpcHandlerManager,createHost:params.deps?.createRegistryHost});
  registerPetRpcHandlers({
    rpcHandlerManager,
    createAccountPet: params.deps?.createAccountPet,
  });
  const registryTransfers = registerMachineRegistryTransferRpcHandlers({
    rpcHandlerManager,
    createHost: params.deps?.createRegistryHost,
  });
  const transferRelayV2DownloadOwners: readonly TransferRelayV2DownloadSessionOwner[] = [
    ...(params.deps?.extraTransferRelayV2DownloadOwners ?? []),
    {
      store: promptAssetTransfers.downloadStore,
      lifecycle: createTransferSessionLifecycle({
        store: promptAssetTransfers.downloadStore,
        chunkSizeBytes: configuration.filesTransferChunkBytes,
      }),
    },
    {
      store: registryTransfers.downloadStore,
      lifecycle: createTransferSessionLifecycle({
        store: registryTransfers.downloadStore,
        chunkSizeBytes: configuration.filesTransferChunkBytes,
      }),
    },
  ];
  if (handlers.transferRelayV2Channel) {
    transferRelayV2ResponderCleanup = registerTransferRelayV2DownloadSessionResponder({
      machineId: handlers.transferRelayV2Channel.machineId,
      transferRelayChannel: handlers.transferRelayV2Channel,
      resolveSessionOwner: (transferId) => {
        for (const owner of transferRelayV2DownloadOwners) {
          if (owner.store.getDownloadSession(transferId) || owner.store.hasNativeSession('download', transferId)) {
            return owner;
          }
        }
        return null;
      },
    });
    transferRelayV2DownloadResponderCleanupByManager.set(rpcHandlerManager, transferRelayV2ResponderCleanup);
  }
  const externalSessionsRegistration = registerMachineExternalSessionsRpcHandlers({
    ...(memoryWorker ? { memoryWorker } : {}),
    ...(params.deps?.nativeUsage && params.deps.executionBudgetRegistry
      ? { nativeUsage: { ...params.deps.nativeUsage, budgetRegistry: params.deps.executionBudgetRegistry } }
      : {}),
    rpcHandlerManager,
    ...(params.deps?.actionOperations?.attachOwner ? { actionOperations: { attachOwner: params.deps.actionOperations.attachOwner } } : {}),
    operationExclusion: externalSessionOperationExclusion,
    spawnSession,
    stopSession: async (sessionId) => (
      normalizeMachineStopSessionResult(await stopSession(sessionId)).status === 'stopped'
    ),
    emitExternalSessionTranscriptUpdate: params.deps?.emitExternalSessionTranscriptUpdate,
    emitExternalSessionSourceUnavailableOccurrence: params.deps?.emitExternalSessionSourceUnavailableOccurrence,
    ...(params.deps?.deviceLocalSecretStorage
      ? { deviceLocalSecretStorage: params.deps.deviceLocalSecretStorage }
      : {}),
    executeExternalSessionHistoricalImportCommand:
      params.deps?.executeExternalSessionHistoricalImportCommand,
    persistedTakeoverAdmissionWaiter:
      params.deps?.persistedTakeoverAdmissionWaiter,
    attachPersistedTakeoverAdmissionOwner:
      params.deps?.attachPersistedTakeoverAdmissionOwner,
    installExternalSessionHostOperations:
      params.deps?.installExternalSessionHostOperations,
    readMaterializedStateObservationBinding:
      params.deps?.readMaterializedStateObservationBinding,
    transientMediaReadAllowance: params.deps?.transientMediaReadAllowance,
    getServerFeaturesSnapshot: params.deps?.getServerFeaturesSnapshot,
    machineId: params.deps?.currentMachineId,
    ...(params.deps?.subscribeSessionArchivedStateChanges
      ? {
          subscribeSessionArchivedStateChanges:
            params.deps.subscribeSessionArchivedStateChanges,
        }
      : {}),
    ...(params.deps?.subscribeSessionDeletedChanges
      ? {
          subscribeSessionDeletedChanges:
            params.deps.subscribeSessionDeletedChanges,
        }
      : {}),
    ...(params.deps?.currentMachineId && params.deps.externalSessionStatusDemandChannel
      ? {
          statusDemand: {
            channel: params.deps.externalSessionStatusDemandChannel,
            machineId: params.deps.currentMachineId,
            ...(params.deps.subscribeConnectedAccountInvalidations
              ? {
                  subscribeConnectedAccountInvalidations:
                    params.deps.subscribeConnectedAccountInvalidations,
                }
              : {}),
          },
        }
      : {}),
  });
  // Children of a client Action this daemon admitted and is still awaiting.
  rpcHandlerManager.registerHandler(RPC_METHODS.UI_ACTION_CHILD_EXECUTE, async (raw: unknown, context) => {
    const { executeAdmittedClientActionChild } = await import('@/session/actions/admittedClientActionChildren');
    return await executeAdmittedClientActionChild(raw, context);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH, async (raw: unknown) => {
    const parsed = parseSessionConnectedServiceAuthSwitchRpcParams(raw);
    if (!parsed) {
      return { ok: false, errorCode: 'unsupported_service' };
    }
    return await requestDaemonSessionConnectedServiceAuthSwitch(parsed);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, async (raw: unknown, context) => {
    const request = RestartSessionRunnerRequestV1Schema.parse(raw);
    if (isUnattestedPublicV1RunnerRolloutMutation(request)) {
      return {
        ok: false as const,
        status: 'ineligible' as const,
        sessionId: request.sessionId,
        reasonCode: 'runner_generation_unattested' as const,
      };
    }
    return await requestDaemonSessionRunnerRestart(request, { signal: context?.signal });
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_CONFIRMED_BACKGROUND, async (raw: unknown, context) => {
    const request = RestartSessionRunnerConfirmedBackgroundRequestSchema.parse(raw);
    return await requestDaemonSessionRunnerRestartConfirmedBackground(request, { signal: context?.signal });
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, async (raw: unknown, context) => {
    const request = RestartSessionRunnerRequestV2Schema.parse(raw);
    return await requestDaemonSessionRunnerRestartV2(request, { signal: context?.signal });
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL, async (raw: unknown, context) => {
    const request = RestartAllSessionRunnersRequestV1Schema.parse(raw);
    if (isUnattestedPublicV1RunnerRolloutMutation(request)) {
      return {
        ok: false as const,
        mode: request.mode,
        requestedCount: 0,
        restartedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        results: [],
      };
    }
    return await restartAllDaemonSessionRunners(request, { signal: context?.signal });
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET, async (raw: unknown) => {
    const request = SessionRunnerStatusGetRequestV1Schema.parse(raw);
    if (!params.deps?.sessionRunnerStatus) throw new Error('Daemon session runner status owner is unavailable');
    return await params.deps.sessionRunnerStatus.get(request);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET, async (raw: unknown) => {
    const request = SessionRunnerStatusGetRequestV1Schema.parse(raw);
    if (!params.deps?.sessionRunnerStatus) throw new Error('Daemon session runner status owner is unavailable');
    return await params.deps.sessionRunnerStatus.getV2(request);
  });
  registerMachineSpawnSessionNonceRpcHandlers({
    rpcHandlerManager,
    ...(handlers.resolveSpawnSessionByNonce
      ? { resolveSpawnSessionByNonce: handlers.resolveSpawnSessionByNonce }
      : {}),
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SPAWN_SESSION_ABANDON, async (input: { spawnNonce?: unknown }) => {
    const spawnNonce = typeof input?.spawnNonce === 'string' ? input.spawnNonce.trim() : '';
    if (!spawnNonce) return { status: 'not_found' as const };
    if (!handlers.abandonSpawnSessionByNonce) return { status: 'unsupported' as const };
    try {
      return await handlers.abandonSpawnSessionByNonce(spawnNonce);
    } catch {
      return { status: 'failed' as const };
    }
  });
  if (handlers.directTransferImport) {
    registerMachineDirectTransferImportRpcHandlers({
      rpcHandlerManager,
      effectAdmission: filesystemEffectAdmission,
      admissionDrain: params.deps?.managedActivity?.admissionDrain,
      prepareImportSession: async (request, _scope, context) => {
        const scope = params.deps?.createFilesystemTransferScope?.(request.workingDirectory, context);
        if (!scope) throw Object.assign(new Error('Requester-bound filesystem IO is unavailable on this Machine'),
          { errorCode: 'filesystem_identity_custody_unavailable' });
        return await handlers.directTransferImport!.prepareImportSession(request, scope);
      },
      abortImportSession: async input => {
        // A verified current physical owner administers the owning lifecycle;
        // unadmitted raw callers never receive this trusted cleanup capability.
        return await handlers.directTransferImport!.abortImportSession(input);
      },
    });
  }
  if (externalAction && (handlers.directTransferImport || handlers.directTransferExport)) {
    registerActionSpecRpcHandlers<FilesystemTransferActionId>({ rpcHandlerManager, actionIds: FILESYSTEM_TRANSFER_ACTION_IDS,
      actionExecutor: externalAction.executor,
      ...(params.deps?.currentMachineId ? { targetMachineId: params.deps.currentMachineId, defaultMachineTarget: true } : {}),
      ...(params.deps?.actionOperations ? { observeExecution: params.deps.actionOperations.observeExecution } : {}),
    });
  }
  if (handlers.directTransferExport) {
    registerMachineDirectTransferExportRpcHandlers({
      rpcHandlerManager,
      effectAdmission: filesystemEffectAdmission,
      admissionDrain: params.deps?.managedActivity?.admissionDrain,
      prepareExportSession: async (request, scope, context) => {
        if (request.t === 'workspace_file_download_v1') {
          scope = params.deps?.createFilesystemTransferScope?.(request.workingDirectory, context);
          if (!scope) throw Object.assign(new Error('Requester-bound filesystem IO is unavailable on this Machine'),
            { errorCode: 'filesystem_identity_custody_unavailable' });
        }
        return await handlers.directTransferExport!.prepareExportSession(request, scope, context);
      },
      ...(handlers.directTransferExport.releaseExportSession ? { releaseExportSession: async (transferId: string) => {
        await handlers.directTransferExport!.releaseExportSession!(transferId);
      } } : {}),
    });
  }
  const sessionHandoffPreflight = params.deps?.sessionHandoffPreflight;
  const admitExistingSessionState: NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['admitExistingSessionState']> | undefined = sessionHandoffPreflight
    ? async (peerMachineId, context, checkRequest) => {
        const unavailable = () => ({ ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' });
        if (!checkRequest || peerMachineId !== checkRequest.targetMachineId) return unavailable();
        const requester = context?.requesterSessionBootstrap;
        // A signed or foreign requester cannot borrow this installation's Account credentials.
        if (!requester && (context?.callerInputAuthorization
          || context?.machineAdmission && context.machineAdmission.actorAccountId !== context.machineAdmission.custodianAccountId)) return unavailable();
        const credentials = requester?.credentials ?? await sessionHandoffPreflight.readCredentials();
        if (!credentials || requester && !await requester.isCurrent()) return unavailable();
        const actionContext = context ? buildActionExecutorContextForRpc({ ...context,
          actionId: 'session.handoff', defaultSessionId: checkRequest.sessionId }) : undefined;
        if (context?.callerInputAuthorization && actionContext?.externalActionExecutionAuthorization !== context.callerInputAuthorization) return unavailable();
        return await admitSessionHandoffExistingState({ credentials, request: checkRequest,
          ...(actionContext ? { context: actionContext } : {}), rpc: sessionHandoffPreflight.callMachine,
          ...(context?.signal ? { signal: context.signal } : {}) });
      }
    : undefined;
  registerMachineSessionHandoffRpcHandlers({
    rpcHandlerManager,
    ...(params.deps?.prepareManagedSessionHandoffDirectoryPlacement ? { prepareManagedDirectoryPlacement: params.deps.prepareManagedSessionHandoffDirectoryPlacement } : {}),
    ...(params.deps?.currentMachineId ? { localMachineId: params.deps.currentMachineId } : {}),
    ...(admitExistingSessionState ? { admitExistingSessionState } : {}),
    ...(params.deps?.workspaceSync?.captureHandoffWorkspace ? { captureWorkspace: params.deps.workspaceSync.captureHandoffWorkspace } : {}),
    prepareMemberImport: async context => (await import('@/session/handoff/agentBundle/memberImport')).prepareMemberSessionHandoffImport(context, {
      agentIsolation: params.deps?.agentIsolation,
      resolveHostHomeServerIdentityId: params.deps?.resolveHostHomeServerIdentityId }),
    ...(params.deps?.requesterSessionRuntime ? { requesterSessionRuntime: params.deps.requesterSessionRuntime } : {}),
    ...(params.deps?.requesterBootstrapBoundary ? { requesterBootstrapBoundary: params.deps.requesterBootstrapBoundary } : {}),
    sessionOperationExclusion: externalSessionOperationExclusion,
    spawnSessionForHandoff: handlers.spawnSession,
    stopSessionForHandoff: async (sessionId, options) => {
      if (options?.expectedSpawnNonce) {
        return await params.deps?.requesterSessionRuntime?.stopForHandoff?.(sessionId, options.expectedSpawnNonce) ?? 'failed';
      }
      const isActive = await handlers.isSessionActive?.(sessionId) ?? false;
      if (!isActive) {
        return 'already_inactive';
      }
      return normalizeMachineStopSessionResult(await stopSession(sessionId)).status === 'stopped'
        ? 'stopped'
        : 'failed';
    },
    ...(handlers.loadLocalSessionMetadata ? { loadLocalSessionMetadata: handlers.loadLocalSessionMetadata } : {}),
    ...(handlers.machineTransferChannel ? { machineTransferChannel: handlers.machineTransferChannel } : {}),
    ...(handlers.directPeerTransfer ? { directPeerTransfer: handlers.directPeerTransfer } : {}),
    ...(params.deps?.resolveServerFeaturesSnapshot
      ? { resolveServerFeaturesSnapshot: params.deps.resolveServerFeaturesSnapshot }
      : {}),
    ...(params.deps?.actionOperations
      ? { observeExecution: params.deps.actionOperations.observeExecution }
      : {}),
    ...(params.deps?.sessionHandoffCoordinator
      ? { coordinateSessionHandoff: params.deps.sessionHandoffCoordinator }
      : {}),
  });
  registerMachineDiagnosticsRpcHandlers({ rpcHandlerManager, filesystemEffectAdmission });

  const executionRunCpu = createProcessCpuSampler();
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, async (_raw, context) => {
    const admission = context?.machineAdmission;
    const serverId = params.deps?.currentServerId ?? configuration.activeServerId;
    // The registry filters private attribution before publishing marker fields.
    // Only the authenticated receiving admission establishes the requester.
    const markers = await listExecutionRunMarkers(admission?.role === 'use' ? {
      requester: { serverId, accountId: admission.actorAccountId, machineId: admission.machineId,
        installationId: admission.installationId },
      homeServerIdentityId: await (params.deps?.resolveHostHomeServerIdentityId?.()
        ?? resolveServerProfileHomeIdentityId(serverId)),
    } : undefined);

    let processIndex = new Map<number, DaemonExecutionRunProcessInfo>();
    try {
      const snapshot = await readProcessCensus({ freshness: 'shared', pids: markers.map(marker => marker.pid),
        fields: ['memory', 'cpuTimeUs'] });
      if (snapshot.status === 'ok') {
        // On-demand reads share the live-view minimum span, even when viewers read close together.
        const cpu = executionRunCpu.sample(snapshot, MACHINE_VITALS_LIVE_INTERVAL_MS, params.deps?.readMachineEffectiveCores?.());
        processIndex = new Map(snapshot.rows.map(row => [row.pid, {
          pid: row.pid,
          name: row.name,
          cpu: cpu.get(row.pid),
          memory: row.memory?.bytes,
        }]));
      }
    } catch {
      // Optional process statistics remain best-effort when native facts are unavailable.
    }

    const runs: DaemonExecutionRunEntry[] = markers.map((marker) => {
      const process = processIndex.get(marker.pid);
      return process ? { ...marker, process } : marker;
    });

    return { runs };
  });

  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE,
    async (raw: unknown) => {
      const request = DaemonExecutionRunBrokerAuthorityRequestV1Schema.parse(raw);
      const snapshot = params.deps?.getServerFeaturesSnapshot?.();
      const serverIdentityId = snapshot?.status === 'ready'
        ? snapshot.features.capabilities.serverIdentity.serverIdentityId
        : null;
      const result = await resolveDaemonExecutionRunBrokerAuthority(request, {
        currentIdentity: serverIdentityId && params.deps?.executionRunRuntimeAccountId && params.deps.currentMachineId
          ? {
              serverIdentityId,
              accountId: params.deps.executionRunRuntimeAccountId,
              machineId: params.deps.currentMachineId,
            }
          : null,
        listMarkers: listExecutionRunMarkersForRehydration,
        isPidAlive: isPidPresent,
        resolveLiveAuthority: async (input) => {
          if (input.sessionId === null) {
            return detachedExecutionRunManager?.resolveLiveBrokerAuthority({
              v: 1,
              executionRunId: input.executionRunId,
              ...(input.expectedIntent !== undefined ? { expectedIntent: input.expectedIntent } : {}),
              expectedOccurrenceId: input.expectedOccurrenceId,
              ...(input.expectedDirectMaterialUse
                ? { expectedDirectMaterialUse: input.expectedDirectMaterialUse }
                : {}),
            }) ?? { status: 'not_current', reason: 'runtime_unavailable' };
          }
          if (!params.deps?.resolveExecutionRunLiveBrokerAuthority) {
            return { status: 'not_current', reason: 'runtime_unavailable' };
          }
          // An attached Run's live owner checks the Home's direct-material
          // expectation exactly as a detached Run's does.
          return await params.deps.resolveExecutionRunLiveBrokerAuthority({
            sessionId: input.sessionId,
            requestingAccountId: input.requestingAccountId,
            executionRunId: input.executionRunId,
            ...(input.expectedIntent !== undefined ? { expectedIntent: input.expectedIntent } : {}),
            expectedOccurrenceId: input.expectedOccurrenceId,
            ...(input.expectedDirectMaterialUse
              ? { expectedDirectMaterialUse: input.expectedDirectMaterialUse }
              : {}),
          });
        },
      });
      return DaemonExecutionRunBrokerAuthorityResponseV1Schema.parse(result);
    },
  );

  registerSessionLifecycleRpcHandlers({
    rpcHandlerManager,
    actionExecutor: createMachineSessionStopLifecycleActionExecutor({
      stopSession,
    }),
    ...(params.deps?.requesterSessionRuntime ? { requesterSessionRuntime: params.deps.requesterSessionRuntime } : {}),
    scopes: MACHINE_SESSION_STOP_RPC_SCOPES,
  });

  // Register stop daemon handler
  rpcHandlerManager.registerHandler(RPC_METHODS.STOP_DAEMON, () => {
    logger.debug('[API MACHINE] Received stop-daemon RPC request');

    // Trigger shutdown callback after a delay
    setTimeout(() => {
      logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
      requestShutdown();
    }, 100);

    return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
  });

  return {
    hostCapabilities,
    probeInactiveUsageLimitRecovery,
    retireFiniteExecution,
    captureExecutionRunResumeMaterialization: (runId, occurrenceId) =>
      detachedExecutionRunManager?.captureResumeMaterialization(runId, occurrenceId) ?? null,
    captureExecutionRunWorkflowRequester: runId => detachedExecutionRunManager?.captureWorkflowRequester(runId) ?? null,
    getFiniteTerminalSessions: terminalRegistration.getSessionManager,
    liveWorkProducers: [
      executionBudgetRegistry.getLiveWorkProducer(),
      terminalRegistration.getSessionManager().getLiveWorkProducer(),
    ],
    cleanupRequesterMachineTerminals: terminalRegistration.cleanupRequesterMachineTerminals,
    ...(operationStore?.readActiveProjectCommands ? { readActiveProjectCommands: operationStore.readActiveProjectCommands } : {}),
    projectFiniteExecutionInstalled: Boolean(resolveProjectFiniteRuntime && params.deps?.currentMachineId && params.deps.currentServerId),
    ...(handlers.isSessionActive ? { isSessionActive: handlers.isSessionActive } : {}),
    ...(resolveProjectFiniteRuntime ? { resolveProjectFiniteRuntime } : {}),
    sessionsRoleFamily,
    externalSessionHostActionExecutor:
      externalSessionsRegistration.hostExternalSessionActionExecutor,
    ...(externalSessionsRegistration.pluginAdmissionOwner
      ? {
          externalSessionPluginAdmissionOwner:
            externalSessionsRegistration.pluginAdmissionOwner,
        }
      : {}),
    connectivityResources: externalSessionsRegistration.connectivityResource
      ? [externalSessionsRegistration.connectivityResource]
      : [],
    transferRelayV2DownloadOwners,
    promptAssetTransfers,
    registryTransfers,
    voiceSpeech: voiceSpeechRegistration,
    voiceClientCredentials: voiceClientCredentialRegistration,
    voiceClientMediatedCredentials: voiceClientMediatedCredentialRegistration,
    dispose: async () => {
      try {
        await retireFiniteExecution();
        const cleanup = transferRelayV2ResponderCleanup;
        transferRelayV2ResponderCleanup = null;
        const executionRunManager = detachedExecutionRunManager;
        detachedExecutionRunManager = null;
        cleanup?.();
        if (cleanup && transferRelayV2DownloadResponderCleanupByManager.get(rpcHandlerManager) === cleanup) {
          transferRelayV2DownloadResponderCleanupByManager.delete(rpcHandlerManager);
        }
        await Promise.all([
          ...(executionRunManager ? [executionRunManager.dispose()] : []),
          Promise.resolve(terminalRegistration.dispose()),
          Promise.resolve(externalSessionsRegistration.dispose()),
          promptAssetTransfers.dispose(),
          registryTransfers.dispose(),
          voiceSpeechRegistration.dispose(),
          voiceClientCredentialRegistration.dispose(),
          voiceClientMediatedCredentialRegistration.dispose(),
        ]);
      } finally {
        executionRunRegistration.dispose();
      }
    },
  };
}
