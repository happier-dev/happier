import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { listProcessSnapshot } from '@/daemon/processSnapshotCache';
import {
  StopSessionResultSchema,
  type StopSessionResult,
} from '@/daemon/sessions/stopSessionContract';
import type {
  DaemonExecutionRunEntry,
  DaemonExecutionRunProcessInfo,
  SpawnSessionNonceResolution,
} from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import type { VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';
import {
  registerMachineVoiceInferenceRpcHandlers,
  type MachineVoiceInferenceRpcRegistration,
} from './rpcHandlers.voiceInference';
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
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import {
  registerMachineProviderRpcHandlers,
  type MachineProviderRpcServices,
} from './rpcHandlers.providers';
import {
  registerMachineExternalSessionsRpcHandlers,
  type ExternalSessionArchivedStateChange,
} from './rpcHandlers.externalSessions';
import {
  registerMachineSessionHandoffRpcHandlers,
  type SessionHandoffDirectPeerTransferHandle,
} from './sessionHandoff/handlers';
import { registerMachinePromptAssetsRpcHandlers } from './rpcHandlers.promptAssets';
import {
  registerMachinePromptAssetTransferRpcHandlers,
  type MachinePromptAssetTransferRpcRegistration,
} from './rpcHandlers.promptAssetTransfers';
import { registerMachineMarketplaceSourcesRpcHandlers } from './rpcHandlers.marketplaceSources';
import { registerMachinePromptRegistriesRpcHandlers } from './rpcHandlers.promptRegistries';
import {
  registerMachinePromptRegistryTransferRpcHandlers,
  type MachinePromptRegistryTransferRpcRegistration,
} from './rpcHandlers.promptRegistryTransfers';
import { registerPetRpcHandlers } from '@/pets/rpc/registerPetRpcHandlers';
import { registerMachineDirectTransferImportRpcHandlers } from './rpcHandlers.directTransferImports';
import {
  registerMachineDirectTransferExportRpcHandlers,
  type DirectTransferExportPrepareRequest,
} from './rpcHandlers.directTransferExports';
import { registerMachineDiagnosticsRpcHandlers } from './rpcHandlers.diagnostics';
import { registerMachineSessionRpcHandlers } from './rpcHandlers.sessions';
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
import type { DaemonUsageLimitRecoveryFieldMutation } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
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
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { registerSessionPermissionRpcHandlers } from '@/rpc/handlers/sessionPermissions';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { MACHINE_SESSION_STOP_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { registerSubagentRpcHandlers } from '@/rpc/handlers/subagents';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';
import type { SessionLifecycleMachineDeps } from '@/session/actions/lifecycle/sessionLifecycleTypes';
import { registerTransferRelayV2DownloadSessionResponder } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import type { TransferRelayV2DownloadSessionOwner } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import { configuration } from '@/configuration';
import type { TransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import type {
  AccountPetCreateRequestV1,
  AccountPetCreateResponseV1,
  ConnectedServiceBindingsV1,
  ExternalSessionOperationSocketCommandV1,
  ExternalSessionOperationSocketResponseV1,
  ExternalSessionTranscriptInvalidationV1,
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  TransferEndpointCandidate,
  TransferRelayV2SendEnvelope,
} from '@happier-dev/protocol';
import {
  RestartAllSessionRunnersRequestV1Schema,
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerRequestV2Schema,
  SessionConnectedServiceAuthSwitchRpcParamsSchema,
  SessionRunnerStatusGetRequestV1Schema,
} from '@happier-dev/protocol';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import {
  createExternalSessionOperationExclusion,
  type ExternalSessionOperationExclusionOwner,
} from '@/session/external/operationExclusion';
import {
  resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs,
} from '@/session/actions/externalSessions/operationProgressPublisher';
import type { DirectTransferImportOpenRequest } from '@/machines/transfer/directTransferImportSession';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import {
  getDaemonSessionRunnerStatus,
  getDaemonSessionRunnerStatusV2,
  requestDaemonSessionConnectedServiceAuthSwitch,
  requestDaemonSessionRunnerRestart,
  requestDaemonSessionRunnerRestartV2,
  restartAllDaemonSessionRunners,
} from '@/daemon/controlClient';
import { isUnattestedPublicV1RunnerRolloutMutation } from '@/daemon/plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';

const transferRelayV2DownloadResponderCleanupByManager = new WeakMap<RpcHandlerManager, () => void>();
const MACHINE_RPC_HANDLER_OWNER = 'machine-rpc-surface';

function parseSessionConnectedServiceAuthSwitchRpcParams(raw: unknown): Readonly<{
  sessionId: string;
  agentId: string;
  bindings: ConnectedServiceBindingsV1;
  expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
}> | null {
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
  resolveSpawnSessionByNonce?: (spawnNonce: string) => Promise<SpawnSessionNonceResolution>;
  abandonSpawnSessionByNonce?: (spawnNonce: string) => Promise<
    | { status: 'completed'; sessionId: string }
    | { status: 'pending' | 'not_found' | 'unsupported' | 'failed' }
  >;
  stopSession: (sessionId: string) => Promise<MachineStopSessionHandlerResult>;
  isSessionActive?: (sessionId: string) => Promise<boolean>;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  savePreparedTargetLocalMetadata?: (input: Readonly<{
    remoteSessionId: string;
    exportMetadataOverlay: Record<string, unknown>;
  }>) => Promise<void> | void;
  requestShutdown: () => void;
  memory?: MemoryWorkerHandle;
  daemonServerWorkScheduler?: Pick<DaemonServerWorkScheduler, 'getSnapshot'>;
  voiceInference?: VoiceInferenceWorkerHandle;
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
    prepareImportSession: (input: DirectTransferImportOpenRequest) => Promise<Readonly<{
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
    ) => Promise<void | Readonly<{ aborted: boolean }>>;
  }>;
  directTransferExport?: Readonly<{
    prepareExportSession: (input: DirectTransferExportPrepareRequest) => Promise<Readonly<{
      transferId: string;
      endpointCandidates: readonly TransferEndpointCandidate[];
      expiresAt: number;
    }>>;
  }>;
};

export type MachineRpcHandlerDeps = Readonly<{
  /**
   * Host-private server-origin Session-start binding. The session RPC owner
   * supplies its lifecycle and nonce handlers at registration time.
   */
  sessionServerStart?: Omit<
    MachineSessionServerStartRpcRegistrationOptions,
    'spawnLifecycleHandler' | 'resolveSpawnSessionByNonce'
  >;
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
  createCapabilitiesApiClient?: NonNullable<
    Parameters<typeof registerCapabilitiesHandlers>[1]
  >['createApiClient'];
  runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  resolveExecutionSurfaces?: SessionLifecycleMachineDeps['resolveExecutionSurfaces'];
  awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
  promptAssetsHomedir?: () => string;
  promptAssetsHappierHomeDir?: () => string;
  workingDirectory?: string;
  filesystemAccessPolicy?: FilesystemAccessPolicy;
  terminalRegistry?: TerminalProcessRegistry;
  getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
  transientMediaReadAllowance?: TransientSessionMediaReadAllowance;
  extraTransferRelayV2DownloadOwners?: readonly TransferRelayV2DownloadSessionOwner[];
  emitExternalSessionTranscriptUpdate?: (payload: ExternalSessionTranscriptInvalidationV1) => void | Promise<void>;
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
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  readInactiveSessionUsageLimitRecovery?: ReadInactiveSessionUsageLimitRecovery;
  cancelConnectedServiceRuntimeAuthRecovery?: CancelConnectedServiceRuntimeAuthRecovery;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
  currentMachineId?: string;
  externalSessionStatusDemandChannel?: ExternalSessionStatusDemandChannel;
  subscribeSessionArchivedStateChanges?: (
    listener: (
      change: ExternalSessionArchivedStateChange,
    ) => void | Promise<void>,
  ) => () => void;
  subscribeConnectedAccountInvalidations?: (listener: () => void) => () => void;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  stageUsageLimitRecoveryMutation?: (input: Readonly<{
    mutation: DaemonUsageLimitRecoveryFieldMutation;
    rawSession: RawSessionRecord;
  }>) => Promise<void>;
}>;

export type MachineRpcLifecycleRegistration = Readonly<{
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  connectivityResources: readonly Readonly<{
    name: string;
    pause(): void | Promise<void>;
    resume(): void | Promise<void>;
  }>[];
  transferRelayV2DownloadOwners: readonly TransferRelayV2DownloadSessionOwner[];
  promptAssetTransfers: MachinePromptAssetTransferRpcRegistration;
  promptRegistryTransfers: MachinePromptRegistryTransferRpcRegistration;
  voiceInference?: MachineVoiceInferenceRpcRegistration;
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
  transferRelayV2DownloadResponderCleanupByManager.get(rpcHandlerManager)?.();
  transferRelayV2DownloadResponderCleanupByManager.delete(rpcHandlerManager);
  const { spawnSession, stopSession, requestShutdown } = handlers;
  const memoryWorker = handlers.memory ?? null;
  const voiceInferenceWorker = handlers.voiceInference ?? null;
  const externalSessionOperationExclusion =
    params.deps?.externalSessionOperationExclusion
    ?? createExternalSessionOperationExclusion({
      activeServerDir: configuration.activeServerDir,
      ownerId: `cli-daemon:${process.pid}:session-operations:${randomUUID()}`,
      claimMutationLockAcquisitionTimeoutMs:
        resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs(),
    });
  let transferRelayV2ResponderCleanup: (() => void) | null = null;

  registerMachineSessionRpcHandlers({
    rpcHandlerManager,
    handlers,
    deps: params.deps,
  });
  registerMachineSessionGoalRpcHandlers({
    rpcHandlerManager,
    deps: {
      resumeInactiveSessionWhenUsageLimitReady: params.deps?.resumeInactiveSessionWhenUsageLimitReady,
      scheduleInactiveSessionUsageLimitRecoveryCheck: params.deps?.scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck: params.deps?.cancelInactiveSessionUsageLimitRecoveryCheck,
      readInactiveSessionUsageLimitRecovery: params.deps?.readInactiveSessionUsageLimitRecovery,
      cancelConnectedServiceRuntimeAuthRecovery: params.deps?.cancelConnectedServiceRuntimeAuthRecovery,
      retryTemporaryThrottleNow: params.deps?.retryTemporaryThrottleNow,
      currentMachineId: params.deps?.currentMachineId,
      stageUsageLimitRecoveryMutation: params.deps?.stageUsageLimitRecoveryMutation,
    },
  });
  registerMachineConnectedServiceQuotaRpcHandlers({ rpcHandlerManager });
  registerApprovalRpcHandlers({ rpcHandlerManager });
  // Detached execution runs are owned by this exact authenticated daemon. Reuse
  // the incumbent execution-run bridge/action family with its nullable scope;
  // no Admin target picker, Session projection, or parallel daemon registry.
  registerCapabilitiesHandlers(rpcHandlerManager, {
    ...(params.deps?.createCapabilitiesApiClient
      ? { createApiClient: params.deps.createCapabilitiesApiClient }
      : {}),
  });
  registerExecutionRunHandlers(rpcHandlerManager, {
    sessionId: null,
    cwd: params.deps?.workingDirectory ?? process.cwd(),
    ...(params.deps?.currentMachineId ? { machineId: params.deps.currentMachineId } : {}),
    ...(params.deps?.getServerFeaturesSnapshot
      ? { getServerFeaturesSnapshot: params.deps.getServerFeaturesSnapshot }
      : {}),
    parentProvider: 'daemon.executionRuns',
    sendAcp: async () => {},
  });
  registerSessionPermissionRpcHandlers({ rpcHandlerManager });
  registerSubagentRpcHandlers({ rpcHandlerManager });

  if (memoryWorker) {
    registerMachineMemoryRpcHandlers({
      rpcHandlerManager,
      memoryWorker,
    });
  }

  if (handlers.daemonServerWorkScheduler) {
    registerMachineServerWorkRpcHandlers({
      rpcHandlerManager,
      daemonServerWorkScheduler: handlers.daemonServerWorkScheduler,
    });
  }

  const voiceInferenceRegistration = voiceInferenceWorker
    ? registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager,
      voiceInferenceWorker,
    })
    : null;

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

  registerMachineTerminalRpcHandlers({
    rpcHandlerManager,
    deps: {
      workingDirectory: params.deps?.workingDirectory,
      accessPolicy: params.deps?.filesystemAccessPolicy,
      ...(params.deps?.terminalRegistry ? { terminalRegistry: params.deps.terminalRegistry } : {}),
    },
  });
  registerMachineMcpServersRpcHandlers({ rpcHandlerManager });
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
  const promptAssetAdapterRegistry = createPromptAssetAdapterRegistry({
    homedir: params.deps?.promptAssetsHomedir,
    happierHomeDir: params.deps?.promptAssetsHappierHomeDir,
    readRegisteredAdapters: () => (
      pluginReloadController.getState().activeRegistry?.promptAssetAdapters ?? new Map()
    ),
  });
  const promptRegistryAdapterRegistry = createPromptRegistryAdapterRegistry();
  registerMachinePromptAssetsRpcHandlers({
    rpcHandlerManager,
    adapterRegistry: promptAssetAdapterRegistry,
  });
  const promptAssetTransfers = registerMachinePromptAssetTransferRpcHandlers({
    rpcHandlerManager,
    adapterRegistry: promptAssetAdapterRegistry,
  });
  registerMachinePromptRegistriesRpcHandlers({
    rpcHandlerManager,
    registry: promptRegistryAdapterRegistry,
    assetRegistry: promptAssetAdapterRegistry,
    deps: {
      homedir: params.deps?.promptAssetsHomedir,
      happierHomeDir: params.deps?.promptAssetsHappierHomeDir,
    },
  });
  registerMachineMarketplaceSourcesRpcHandlers({
    rpcHandlerManager,
    deps: {
      happyHomeDir: params.deps?.promptAssetsHappierHomeDir?.(),
    },
  });
  registerPetRpcHandlers({
    rpcHandlerManager,
    createAccountPet: params.deps?.createAccountPet,
  });
  const promptRegistryTransfers = registerMachinePromptRegistryTransferRpcHandlers({
    rpcHandlerManager,
    registry: promptRegistryAdapterRegistry,
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
      store: promptRegistryTransfers.downloadStore,
      lifecycle: createTransferSessionLifecycle({
        store: promptRegistryTransfers.downloadStore,
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
          if (owner.store.getDownloadSession(transferId)) {
            return owner;
          }
        }
        return null;
      },
    });
    transferRelayV2DownloadResponderCleanupByManager.set(rpcHandlerManager, transferRelayV2ResponderCleanup);
  }
  const externalSessionsRegistration = registerMachineExternalSessionsRpcHandlers({
    rpcHandlerManager,
    operationExclusion: externalSessionOperationExclusion,
    spawnSession,
    stopSession: async (sessionId) => (
      normalizeMachineStopSessionResult(await stopSession(sessionId)).status === 'stopped'
    ),
    emitExternalSessionTranscriptUpdate: params.deps?.emitExternalSessionTranscriptUpdate,
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
    transientMediaReadAllowance: params.deps?.transientMediaReadAllowance,
    getServerFeaturesSnapshot: params.deps?.getServerFeaturesSnapshot,
    machineId: params.deps?.currentMachineId,
    ...(params.deps?.subscribeSessionArchivedStateChanges
      ? {
          subscribeSessionArchivedStateChanges:
            params.deps.subscribeSessionArchivedStateChanges,
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
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH, async (raw: unknown) => {
    const parsed = parseSessionConnectedServiceAuthSwitchRpcParams(raw);
    if (!parsed) {
      return { ok: false, errorCode: 'unsupported_service' };
    }
    return await requestDaemonSessionConnectedServiceAuthSwitch(parsed);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, async (raw: unknown) => {
    const request = RestartSessionRunnerRequestV1Schema.parse(raw);
    if (isUnattestedPublicV1RunnerRolloutMutation(request)) {
      return {
        ok: false as const,
        status: 'ineligible' as const,
        sessionId: request.sessionId,
        reasonCode: 'runner_generation_unattested' as const,
      };
    }
    return await requestDaemonSessionRunnerRestart(request);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, async (raw: unknown) => {
    const request = RestartSessionRunnerRequestV2Schema.parse(raw);
    return await requestDaemonSessionRunnerRestartV2(request);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL, async (raw: unknown) => {
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
    return await restartAllDaemonSessionRunners(request);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET, async (raw: unknown) => {
    const request = SessionRunnerStatusGetRequestV1Schema.parse(raw);
    return await getDaemonSessionRunnerStatus(request);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET, async (raw: unknown) => {
    const request = SessionRunnerStatusGetRequestV1Schema.parse(raw);
    return await getDaemonSessionRunnerStatusV2(request);
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
      prepareImportSession: handlers.directTransferImport.prepareImportSession,
      abortImportSession: handlers.directTransferImport.abortImportSession,
    });
  }
  if (handlers.directTransferExport) {
    registerMachineDirectTransferExportRpcHandlers({
      rpcHandlerManager,
      prepareExportSession: handlers.directTransferExport.prepareExportSession,
    });
  }
  registerMachineSessionHandoffRpcHandlers({
    rpcHandlerManager,
    sessionOperationExclusion: externalSessionOperationExclusion,
    spawnSessionForHandoff: handlers.spawnSession,
    stopSessionForHandoff: async (sessionId) => {
      const isActive = await handlers.isSessionActive?.(sessionId) ?? false;
      if (!isActive) {
        return 'already_inactive';
      }
      return normalizeMachineStopSessionResult(await stopSession(sessionId)).status === 'stopped'
        ? 'stopped'
        : 'failed';
    },
    ...(handlers.loadLocalSessionMetadata ? { loadLocalSessionMetadata: handlers.loadLocalSessionMetadata } : {}),
    ...(handlers.savePreparedTargetLocalMetadata ? { savePreparedTargetLocalMetadata: handlers.savePreparedTargetLocalMetadata } : {}),
    ...(handlers.machineTransferChannel ? { machineTransferChannel: handlers.machineTransferChannel } : {}),
    ...(handlers.directPeerTransfer ? { directPeerTransfer: handlers.directPeerTransfer } : {}),
  });
  registerMachineDiagnosticsRpcHandlers({ rpcHandlerManager });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, async () => {
    const markers = await listExecutionRunMarkers();

    let processIndex = new Map<number, DaemonExecutionRunProcessInfo>();
    try {
      const processes = await listProcessSnapshot();
	      processIndex = new Map(
	        processes.map((proc) => [
	          proc.pid,
	          {
	            pid: proc.pid,
	            name: typeof proc.name === 'string' ? proc.name : undefined,
	            cpu: typeof (proc as any).cpu === 'number' ? (proc as any).cpu : undefined,
	            memory: typeof (proc as any).memory === 'number' ? (proc as any).memory : undefined,
	          },
	        ]),
	      );
    } catch {
      // best-effort; omit process stats if ps-list fails
    }

    const runs: DaemonExecutionRunEntry[] = markers.map((marker) => {
      const process = processIndex.get(marker.pid);
      return process ? { ...marker, process } : marker;
    });

    return { runs };
  });

  registerSessionLifecycleRpcHandlers({
    rpcHandlerManager,
    actionExecutor: createMachineSessionStopLifecycleActionExecutor({
      stopSession,
    }),
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
    promptRegistryTransfers,
    voiceSpeech: voiceSpeechRegistration,
    voiceClientCredentials: voiceClientCredentialRegistration,
    voiceClientMediatedCredentials: voiceClientMediatedCredentialRegistration,
    ...(voiceInferenceRegistration ? { voiceInference: voiceInferenceRegistration } : {}),
    dispose: async () => {
      const cleanup = transferRelayV2ResponderCleanup;
      transferRelayV2ResponderCleanup = null;
      cleanup?.();
      if (cleanup && transferRelayV2DownloadResponderCleanupByManager.get(rpcHandlerManager) === cleanup) {
        transferRelayV2DownloadResponderCleanupByManager.delete(rpcHandlerManager);
      }
      await Promise.all([
        Promise.resolve(externalSessionsRegistration.dispose()),
        promptAssetTransfers.dispose(),
        promptRegistryTransfers.dispose(),
        voiceSpeechRegistration.dispose(),
        voiceClientCredentialRegistration.dispose(),
        voiceClientMediatedCredentialRegistration.dispose(),
        ...(voiceInferenceRegistration ? [voiceInferenceRegistration.dispose()] : []),
      ]);
    },
  };
}
