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
import type { DaemonExecutionRunEntry, DaemonExecutionRunProcessInfo } from '@happier-dev/protocol';

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
  registerMachineVoiceOpenAiCompatRpcHandlers,
  type MachineVoiceOpenAiCompatRpcRegistration,
} from './rpcHandlers.voiceOpenAiCompat';
import {
  registerMachineVoiceSpeechRpcHandlers,
  type MachineVoiceSpeechRpcRegistration,
} from './rpcHandlers.voiceSpeech';
import { createVoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import { createOpenAiCompatVoiceClient } from '@/daemon/voice/openAiCompat/client';
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
  ExternalSessionHostOperationInstallation,
  ExternalSessionHostOperationSet,
} from '@/session/external/hostOperationOwner';
import type {
  CancelConnectedServiceRuntimeAuthRecovery,
  CancelInactiveSessionUsageLimitRecoveryCheck,
  ResumeInactiveSessionWhenUsageLimitReady,
  RetryTemporaryThrottleNow,
  ScheduleInactiveSessionUsageLimitRecoveryCheck,
} from '@/session/actions/createCliActionDeps';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
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
  SessionConnectedServiceAuthSwitchRpcParamsSchema,
  SessionRunnerStatusGetRequestV1Schema,
} from '@happier-dev/protocol';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import type { DirectTransferImportOpenRequest } from '@/machines/transfer/directTransferImportSession';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import {
  getDaemonSessionRunnerStatus,
  requestDaemonSessionConnectedServiceAuthSwitch,
  requestDaemonSessionRunnerRestart,
  restartAllDaemonSessionRunners,
} from '@/daemon/controlClient';

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
  resolveSpawnSessionByNonce?: (spawnNonce: string) => Promise<
    | { status: 'success'; sessionId: string }
    | { status: 'pending' }
    | { status: 'not_found' }
    | { status: 'unsupported' }
  >;
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
  connectivityResources: readonly Readonly<{
    name: string;
    pause(): void | Promise<void>;
    resume(): void | Promise<void>;
  }>[];
  transferRelayV2DownloadOwners: readonly TransferRelayV2DownloadSessionOwner[];
  promptAssetTransfers: MachinePromptAssetTransferRpcRegistration;
  promptRegistryTransfers: MachinePromptRegistryTransferRpcRegistration;
  voiceInference?: MachineVoiceInferenceRpcRegistration;
  voiceOpenAiCompat: MachineVoiceOpenAiCompatRpcRegistration;
  voiceSpeech: MachineVoiceSpeechRpcRegistration;
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
      cancelConnectedServiceRuntimeAuthRecovery: params.deps?.cancelConnectedServiceRuntimeAuthRecovery,
      retryTemporaryThrottleNow: params.deps?.retryTemporaryThrottleNow,
      currentMachineId: params.deps?.currentMachineId,
      stageUsageLimitRecoveryMutation: params.deps?.stageUsageLimitRecoveryMutation,
    },
  });
  registerMachineConnectedServiceQuotaRpcHandlers({ rpcHandlerManager });
  registerApprovalRpcHandlers({ rpcHandlerManager });
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

  const voiceCredentialResolver = createVoiceCredentialResolver({
    machineId: params.deps?.currentMachineId ?? params.deps?.providerRpc?.machineId ?? 'machine_unavailable',
  });
  const voiceOpenAiCompatRegistration = registerMachineVoiceOpenAiCompatRpcHandlers({
    rpcHandlerManager,
    client: createOpenAiCompatVoiceClient({ credentialResolver: voiceCredentialResolver }),
  });
  const voiceSpeechRegistration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager,
      credentialResolver: voiceCredentialResolver,
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
    spawnSession,
    stopSession: async (sessionId) => (
      normalizeMachineStopSessionResult(await stopSession(sessionId)).status === 'stopped'
    ),
    emitExternalSessionTranscriptUpdate: params.deps?.emitExternalSessionTranscriptUpdate,
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
    return await requestDaemonSessionRunnerRestart(request);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL, async (raw: unknown) => {
    const request = RestartAllSessionRunnersRequestV1Schema.parse(raw);
    return await restartAllDaemonSessionRunners(request);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET, async (raw: unknown) => {
    const request = SessionRunnerStatusGetRequestV1Schema.parse(raw);
    return await getDaemonSessionRunnerStatus(request);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE, async (input: { spawnNonce?: unknown }) => {
    const spawnNonce = typeof input?.spawnNonce === 'string' ? input.spawnNonce.trim() : '';
    if (!spawnNonce) return { status: 'not_found' };
    if (!handlers.resolveSpawnSessionByNonce) return { status: 'unsupported' };
    return await handlers.resolveSpawnSessionByNonce(spawnNonce);
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
    connectivityResources: externalSessionsRegistration.connectivityResource
      ? [externalSessionsRegistration.connectivityResource]
      : [],
    transferRelayV2DownloadOwners,
    promptAssetTransfers,
    promptRegistryTransfers,
    voiceOpenAiCompat: voiceOpenAiCompatRegistration,
    voiceSpeech: voiceSpeechRegistration,
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
        voiceOpenAiCompatRegistration.dispose(),
        voiceSpeechRegistration.dispose(),
        ...(voiceInferenceRegistration ? [voiceInferenceRegistration.dispose()] : []),
      ]);
    },
  };
}
