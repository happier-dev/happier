import { logger } from '@/ui/logger';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import psList from 'ps-list';
import type { DaemonExecutionRunEntry, DaemonExecutionRunProcessInfo } from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import type { VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';
import { registerMachineVoiceInferenceRpcHandlers } from './rpcHandlers.voiceInference';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { registerMachineExternalSessionsRpcHandlers } from './rpcHandlers.externalSessions';
import {
  registerMachineSessionHandoffRpcHandlers,
  type SessionHandoffDirectPeerTransferHandle,
} from './sessionHandoff/handlers';
import { registerMachinePromptAssetsRpcHandlers } from './rpcHandlers.promptAssets';
import { registerMachinePromptAssetTransferRpcHandlers } from './rpcHandlers.promptAssetTransfers';
import { registerMachineMarketplaceSourcesRpcHandlers } from './rpcHandlers.marketplaceSources';
import { registerMachinePromptRegistriesRpcHandlers } from './rpcHandlers.promptRegistries';
import { registerMachinePromptRegistryTransferRpcHandlers } from './rpcHandlers.promptRegistryTransfers';
import { registerPetRpcHandlers } from '@/pets/rpc/registerPetRpcHandlers';
import { registerMachineDirectTransferImportRpcHandlers } from './rpcHandlers.directTransferImports';
import {
  registerMachineDirectTransferExportRpcHandlers,
  type DirectTransferExportPrepareRequest,
} from './rpcHandlers.directTransferExports';
import { registerMachineDiagnosticsRpcHandlers } from './rpcHandlers.diagnostics';
import { registerMachineSessionRpcHandlers } from './rpcHandlers.sessions';
import { registerMachineSessionGoalRpcHandlers } from './rpcHandlers.sessionGoals';
import { registerMachineServerWorkRpcHandlers } from './rpcHandlers.serverWork';
import type { DaemonServerWorkScheduler } from '@/daemon/serverWork';
import type {
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
import { registerTransferRelayV2DownloadSessionResponder } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import type { TransferRelayV2DownloadSessionOwner } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import { configuration } from '@/configuration';
import type { TransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import type {
  AccountPetCreateRequestV1,
  AccountPetCreateResponseV1,
  ConnectedServiceBindingsV1,
  ExternalSessionTranscriptDeltaEphemeral,
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  TransferEndpointCandidate,
  TransferRelayV2SendEnvelope,
} from '@happier-dev/protocol';
import { SessionConnectedServiceAuthSwitchRpcParamsSchema } from '@happier-dev/protocol';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import type { DirectTransferImportOpenRequest } from '@/machines/transfer/directTransferImportSession';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { requestDaemonSessionConnectedServiceAuthSwitch } from '@/daemon/controlClient';

const transferRelayV2DownloadResponderCleanupByManager = new WeakMap<RpcHandlerManager, () => void>();
const machineDirectTransferRpcMethodsToReset = [
  RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
  RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
] as const;

function parseSessionConnectedServiceAuthSwitchRpcParams(raw: unknown): Readonly<{
  sessionId: string;
  agentId: string;
  bindings: ConnectedServiceBindingsV1;
  expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
}> | null {
  const parsed = SessionConnectedServiceAuthSwitchRpcParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function removeRegisteredMachineRpcMethods(
  rpcHandlerManager: RpcHandlerManager,
  methods: readonly string[],
): void {
  const manager = rpcHandlerManager as unknown as Readonly<{
    handlers?: Map<string, unknown>;
    scopePrefix?: string;
    socket?: {
      emit: (event: string, payload: Readonly<{ method: string }>) => void;
    } | null;
  }>;
  if (!manager.handlers || !manager.scopePrefix) {
    return;
  }

  for (const method of methods) {
    const prefixedMethod = `${manager.scopePrefix}:${method}`;
    if (manager.handlers.delete(prefixedMethod) && manager.socket) {
      manager.socket.emit(SOCKET_RPC_EVENTS.UNREGISTER, { method: prefixedMethod });
    }
  }
}

export type MachineRpcHandlers = {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  resolveSpawnSessionByNonce?: (spawnNonce: string) => Promise<
    | { status: 'success'; sessionId: string }
    | { status: 'pending' }
    | { status: 'not_found' }
    | { status: 'unsupported' }
  >;
  stopSession: (sessionId: string) => Promise<boolean>;
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
  runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  promptAssetsHomedir?: () => string;
  promptAssetsHappierHomeDir?: () => string;
  workingDirectory?: string;
  filesystemAccessPolicy?: FilesystemAccessPolicy;
  getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
  transientMediaReadAllowance?: TransientSessionMediaReadAllowance;
  extraTransferRelayV2DownloadOwners?: readonly TransferRelayV2DownloadSessionOwner[];
  emitExternalSessionTranscriptUpdate?: (payload: ExternalSessionTranscriptDeltaEphemeral) => void;
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
}>;

export function registerMachineRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>): Readonly<{
  transferRelayV2DownloadOwners: readonly TransferRelayV2DownloadSessionOwner[];
}> {
  const { rpcHandlerManager, handlers } = params;
  transferRelayV2DownloadResponderCleanupByManager.get(rpcHandlerManager)?.();
  transferRelayV2DownloadResponderCleanupByManager.delete(rpcHandlerManager);
  removeRegisteredMachineRpcMethods(rpcHandlerManager, machineDirectTransferRpcMethodsToReset);
  const { spawnSession, stopSession, requestShutdown } = handlers;
  const memoryWorker = handlers.memory ?? null;
  const voiceInferenceWorker = handlers.voiceInference ?? null;

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
      retryTemporaryThrottleNow: params.deps?.retryTemporaryThrottleNow,
    },
  });
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

  if (voiceInferenceWorker) {
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager,
      voiceInferenceWorker,
    });
  }

  registerMachineTerminalRpcHandlers({
    rpcHandlerManager,
    deps: {
      workingDirectory: params.deps?.workingDirectory,
      accessPolicy: params.deps?.filesystemAccessPolicy,
    },
  });
  registerMachineMcpServersRpcHandlers({ rpcHandlerManager });
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
    transferRelayV2DownloadResponderCleanupByManager.set(rpcHandlerManager, registerTransferRelayV2DownloadSessionResponder({
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
    }));
  }
  registerMachineExternalSessionsRpcHandlers({
    rpcHandlerManager,
    spawnSession,
    stopSession,
    emitExternalSessionTranscriptUpdate: params.deps?.emitExternalSessionTranscriptUpdate,
    transientMediaReadAllowance: params.deps?.transientMediaReadAllowance,
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH, async (raw: unknown) => {
    const parsed = parseSessionConnectedServiceAuthSwitchRpcParams(raw);
    if (!parsed) {
      return { ok: false, errorCode: 'unsupported_service' };
    }
    return await requestDaemonSessionConnectedServiceAuthSwitch(parsed);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE, async (input: { spawnNonce?: unknown }) => {
    const spawnNonce = typeof input?.spawnNonce === 'string' ? input.spawnNonce.trim() : '';
    if (!spawnNonce) return { status: 'not_found' };
    if (!handlers.resolveSpawnSessionByNonce) return { status: 'unsupported' };
    return await handlers.resolveSpawnSessionByNonce(spawnNonce);
  });
  if (handlers.directTransferImport) {
    registerMachineDirectTransferImportRpcHandlers({
      rpcHandlerManager,
      prepareImportSession: handlers.directTransferImport.prepareImportSession,
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
      return (await stopSession(sessionId)) ? 'stopped' : 'failed';
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
      const processes = await psList();
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
    transferRelayV2DownloadOwners,
  };
}
