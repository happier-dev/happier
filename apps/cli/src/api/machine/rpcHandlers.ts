import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { logger } from '@/ui/logger';
import { readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from '@/diagnostics/bugReportMachineDiagnosticsRecipe';

import {
  SPAWN_SESSION_ERROR_CODES,
  resolveCanonicalCodexBackendMode,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { canonicalizeSpawnBackendTargetFromTransportInput } from '@/rpc/handlers/spawnSessionOptionsContract';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
  AcpConfigOptionOverridesV1Schema,
  AgentRuntimeDescriptorV1Schema,
  convertBackendTargetRefV2ToV1,
  SessionContinueWithReplayRpcParamsSchema,
  SessionForkRpcParamsSchema,
  SessionMcpSelectionV1Schema,
} from '@happier-dev/protocol';
import { isPermissionMode } from '@/api/types';
import { readCredentials } from '@/persistence';
import { createReplaySeededSession } from '@/session/replay/createReplaySeededSession';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveForkCutoffSeqInclusive } from '@/session/fork/resolveForkCutoffSeqInclusive';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import { resolveSessionForkBackendTarget } from '@/session/fork/resolveSessionForkBackendTarget';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { archiveSessionByIdBestEffort } from '@/session/services/setSessionArchivedState';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import psList from 'ps-list';
import type { DaemonExecutionRunEntry, DaemonExecutionRunProcessInfo } from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';
import {
  registerMachineSessionHandoffRpcHandlers,
  type SessionHandoffDirectPeerTransferHandle,
} from './sessionHandoff/rpcHandlers.sessionHandoff';
import { registerMachinePromptAssetsRpcHandlers } from './rpcHandlers.promptAssets';
import { registerMachinePromptAssetTransferRpcHandlers } from './rpcHandlers.promptAssetTransfers';
import { registerMachinePromptRegistriesRpcHandlers } from './rpcHandlers.promptRegistries';
import { registerMachinePromptRegistryTransferRpcHandlers } from './rpcHandlers.promptRegistryTransfers';
import { registerMachineDirectTransferImportRpcHandlers } from './rpcHandlers.directTransferImports';
import {
  registerMachineDirectTransferExportRpcHandlers,
  type DirectTransferExportPrepareRequest,
} from './rpcHandlers.directTransferExports';
import { registerTransferRelayV2DownloadSessionResponder } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import type { TransferRelayV2DownloadSessionOwner } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import { configuration } from '@/configuration';
import { isAcpForkEligibleForProvider } from '@/agent/acp/acpForkEligibility';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
import type {
  DirectSessionTranscriptDeltaEphemeral,
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  TransferEndpointCandidate,
  TransferRelayV2SendEnvelope,
} from '@happier-dev/protocol';
import {
  applyOpenCodeSessionAffinityMetadata,
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
} from '@/backends/opencode/utils/opencodeSessionAffinity';
import { resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { getAcpForkContinuationHandler } from '@/backends/catalog';
import { dispatchProviderNativeFork } from '@/session/fork/providerNativeForkDispatch';
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
import type { DirectTransferImportOpenRequest } from '@/machines/transfer/directTransferImportSession';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';
import { resolveContinueWithReplayBackendTarget } from '@/session/replay/resolveContinueWithReplayBackendTarget';

const transferRelayV2DownloadResponderCleanupByManager = new WeakMap<RpcHandlerManager, () => void>();
const machineDirectTransferRpcMethodsToReset = [
  RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
  RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
] as const;

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
  stopSession: (sessionId: string) => Promise<boolean>;
  isSessionActive?: (sessionId: string) => Promise<boolean>;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  savePreparedTargetLocalMetadata?: (input: Readonly<{
    remoteSessionId: string;
    exportMetadataOverlay: Record<string, unknown>;
  }>) => Promise<void> | void;
  requestShutdown: () => void;
  memory?: MemoryWorkerHandle;
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
  getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
  extraTransferRelayV2DownloadOwners?: readonly TransferRelayV2DownloadSessionOwner[];
  emitDirectSessionTranscriptUpdate?: (payload: DirectSessionTranscriptDeltaEphemeral) => void;
}>;

async function fetchForkChildSessionOrThrow(params: Readonly<{
  token: string;
  sessionId: string;
  attempts?: number;
  delayMs?: number;
}>): Promise<NonNullable<Awaited<ReturnType<typeof fetchSessionByIdCompat>>>> {
  const attempts = typeof params.attempts === 'number' && params.attempts >= 1 ? Math.floor(params.attempts) : 6;
  const delayMs = typeof params.delayMs === 'number' && params.delayMs >= 0 ? Math.floor(params.delayMs) : 250;
  let lastError: unknown = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      const raw = await fetchSessionByIdCompat({ token: params.token, sessionId: params.sessionId });
      if (raw) return raw;
      lastError = new Error('Session fetch returned empty response');
    } catch (error) {
      lastError = error;
    }
    if (index < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to load forked child session ${params.sessionId}`);
}

async function cleanupForkChildBestEffort(stopSession: (sessionId: string) => Promise<boolean>, sessionId: string): Promise<void> {
  try {
    await stopSession(sessionId);
  } catch {
    // Best-effort only: the important part is surfacing the original fork failure.
  }
}

async function archiveSessionBestEffort(token: string, sessionId: string): Promise<void> {
  await archiveSessionByIdBestEffort({ token, sessionId });
}

async function toCanonicalPath(path: string): Promise<string | null> {
  const normalized = String(path ?? '').trim();
  if (!normalized) return null;
  try {
    return await realpath(normalized);
  } catch {
    return null;
  }
}

function isPathInside(targetPath: string, allowedDir: string): boolean {
  const rel = relative(allowedDir, targetPath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function parseEnvBoundedInt(
  name: string,
  bounds: Readonly<{ min: number; max: number }>,
  fallback: number | null,
): number | null {
  const rawValue = process.env[name];
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) return fallback;
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsedValue));
}

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

  // Register spawn session handler
  rpcHandlerManager.registerHandler(RPC_METHODS.SPAWN_HAPPY_SESSION, async (params: any) => {
    const {
      directory,
      spawnNonce,
      initialPrompt,
      sessionId,
      machineId,
      approvedNewDirectoryCreation,
      backendTarget,
      agent,
      environmentVariables,
      profileId,
      terminal,
      resume,
      connectedServices,
      transcriptStorage,
      attachMetadataIdentityPolicy,
      permissionMode,
      permissionModeUpdatedAt,
      agentModeId,
      agentModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      sessionConfigOptionOverrides,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      experimentalCodexAcp,
      codexBackendMode,
      agentRuntimeDescriptorV1,
      mcpSelection,
    } = params || {};

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
      typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
      normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;
    const normalizedAgentModeId =
      typeof agentModeId === 'string' && agentModeId.trim().length > 0 ? agentModeId.trim() : undefined;
    const normalizedAgentModeUpdatedAt =
      normalizedAgentModeId && typeof agentModeUpdatedAt === 'number' ? agentModeUpdatedAt : undefined;
    const normalizedEnvironmentVariables = environmentVariables && typeof environmentVariables === 'object'
      ? environmentVariables as Record<string, string>
      : undefined;
    const normalizedResume = typeof resume === 'string' ? resume : undefined;
    const normalizedInitialPrompt = typeof initialPrompt === 'string' ? initialPrompt : undefined;
    const normalizedSpawnNonce = typeof spawnNonce === 'string' && spawnNonce.trim().length > 0 ? spawnNonce : undefined;
    const normalizedTranscriptStorage =
      transcriptStorage === 'persisted' || transcriptStorage === 'direct' ? transcriptStorage : undefined;
    const normalizedAttachMetadataIdentityPolicy =
      attachMetadataIdentityPolicy === 'preserve_current_identity'
      || attachMetadataIdentityPolicy === 'replace_with_runtime_identity'
        ? attachMetadataIdentityPolicy
        : undefined;
    const normalizedBackendTargetResolution = canonicalizeSpawnBackendTargetFromTransportInput({
      backendTarget,
      legacyAgent: agent,
    });
    if (normalizedBackendTargetResolution.errorMessage) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: normalizedBackendTargetResolution.errorMessage,
      };
    }
    const normalizedBackendTarget = normalizedBackendTargetResolution.backendTarget;
    const normalizedBackendTargetV1 = normalizedBackendTarget
      ? convertBackendTargetRefV2ToV1(normalizedBackendTarget)
      : undefined;
    const normalizedMcpSelection = (() => {
      if (mcpSelection === undefined) return undefined;
      const parsed = SessionMcpSelectionV1Schema.safeParse(mcpSelection);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedSessionConfigOptionOverrides = (() => {
      if (sessionConfigOptionOverrides === undefined) return undefined;
      const parsed = AcpConfigOptionOverridesV1Schema.safeParse(sessionConfigOptionOverrides);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedAgentRuntimeDescriptorV1 = (() => {
      if (agentRuntimeDescriptorV1 === undefined) return undefined;
      const parsed = AgentRuntimeDescriptorV1Schema.safeParse(agentRuntimeDescriptorV1);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedCodexBackendMode = resolveCanonicalCodexBackendMode({
      codexBackendMode,
      experimentalCodexAcp,
      agentRuntimeDescriptorV1: normalizedAgentRuntimeDescriptorV1,
    });
    const envKeys = normalizedEnvironmentVariables ? Object.keys(normalizedEnvironmentVariables) : [];
    const maxEnvKeysToLog = 20;
    const envKeySample = envKeys.slice(0, maxEnvKeysToLog);
    logger.debug('[API MACHINE] Spawning session', {
      directory,
      sessionId,
      machineId,
      backendTarget: normalizedBackendTarget,
      approvedNewDirectoryCreation,
      profileId,
      terminal,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      agentModeId: normalizedAgentModeId,
      agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
      environmentVariableCount: envKeys.length,
      environmentVariableKeySample: envKeySample,
      environmentVariableKeysTruncated: envKeys.length > maxEnvKeysToLog,
      hasMcpSelection: normalizedMcpSelection !== undefined,
      mcpSelectionForceIncludeCount: normalizedMcpSelection?.forceIncludeServerIds.length ?? 0,
      mcpSelectionForceExcludeCount: normalizedMcpSelection?.forceExcludeServerIds.length ?? 0,
      hasResume: normalizedResume !== undefined,
      codexBackendMode: normalizedCodexBackendMode,
    });

    const buildBaseSpawnOptions = (resolvedDirectory: string): SpawnSessionOptions => ({
      directory: resolvedDirectory,
      spawnNonce: normalizedSpawnNonce,
      initialPrompt: normalizedInitialPrompt,
      machineId,
      backendTarget: normalizedBackendTargetV1,
      environmentVariables: normalizedEnvironmentVariables,
      profileId,
      terminal,
      resume: normalizedResume,
      connectedServices,
      transcriptStorage: normalizedTranscriptStorage,
      attachMetadataIdentityPolicy: normalizedAttachMetadataIdentityPolicy,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      agentModeId: normalizedAgentModeId,
      agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      mcpSelection: normalizedMcpSelection,
      ...(normalizedAgentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: normalizedAgentRuntimeDescriptorV1 } : {}),
      ...(normalizedCodexBackendMode ? { codexBackendMode: normalizedCodexBackendMode } : {}),
    });

    // Handle resume-session type for inactive session resumption
    if (params?.type === 'resume-session') {
      const { sessionId: existingSessionId } = params;
      logger.debug(`[API MACHINE] Resuming inactive session ${existingSessionId}`);

      if (!directory) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Directory is required',
        };
      }
      if (!existingSessionId) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Session ID is required for resume',
        };
      }

      const baseSpawnOptions = buildBaseSpawnOptions(directory);
      const result = await spawnSession({
        ...baseSpawnOptions,
        existingSessionId,
        approvedNewDirectoryCreation: true,
      });

      if (result.type === 'error') {
        return result;
      }

      // For resume, we don't return a new session ID - we're reusing the existing one
      return { type: 'success' };
    }

    if (!directory) {
      return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Directory is required' };
    }
    if (!normalizedBackendTarget) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Backend target is required for fresh session spawn.',
      };
    }

    const baseSpawnOptions = buildBaseSpawnOptions(directory);
    const result = await spawnSession({
      ...baseSpawnOptions,
      sessionId,
      approvedNewDirectoryCreation,
    });

    switch (result.type) {
      case 'success':
        logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
        return { type: 'success', sessionId: result.sessionId };

      case 'requestToApproveDirectoryCreation':
        logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
        return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

      case 'error':
        return result;
    }
  });

  if (memoryWorker) {
    registerMachineMemoryRpcHandlers({
      rpcHandlerManager,
      memoryWorker,
    });
  }

  registerMachineTerminalRpcHandlers({ rpcHandlerManager });
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
  registerMachineDirectSessionsRpcHandlers({
    rpcHandlerManager,
    spawnSession,
    stopSession,
    emitDirectSessionTranscriptUpdate: params.deps?.emitDirectSessionTranscriptUpdate,
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

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, async (raw: unknown) => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid params',
      };
    }

    const resolvedBackend = resolveContinueWithReplayBackendTarget({
      agent: parsed.data.agent,
      backendTarget: parsed.data.backendTarget,
    });
    if (!resolvedBackend.ok) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: resolvedBackend.errorMessage,
      };
    }

    return await continueSessionWithReplay(
      {
        directory: parsed.data.directory,
        backendTarget: resolvedBackend.backendTarget,
        approvedNewDirectoryCreation: parsed.data.approvedNewDirectoryCreation,
        permissionMode: parsed.data.permissionMode,
        permissionModeUpdatedAt: parsed.data.permissionModeUpdatedAt,
        modelId: parsed.data.modelId,
        modelUpdatedAt: parsed.data.modelUpdatedAt,
        replay: parsed.data.replay,
      },
      {
        spawnSession,
        ...(params.deps?.runReplaySummaryForDialog
          ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
          : {}),
      },
    );
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_FORK, async (raw: unknown) => {
    const parsed = SessionForkRpcParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid params',
      };
    }

    const { parentSessionId, forkPoint } = parsed.data;
    const requestedStrategy = typeof parsed.data.strategy === 'string' ? parsed.data.strategy : 'auto';

    if (forkPoint.type === 'seq') {
      const seq = typeof forkPoint.upToSeqInclusive === 'number' && Number.isFinite(forkPoint.upToSeqInclusive)
        ? Math.trunc(forkPoint.upToSeqInclusive)
        : NaN;
      if (!Number.isFinite(seq) || seq <= 0) {
        return {
          ok: false,
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Cannot fork from an uncommitted message (missing seq).',
        };
      }
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Not authenticated',
      };
    }

    let parentSession: Awaited<ReturnType<typeof fetchSessionByIdCompat>> | null = null;
    try {
      parentSession = await fetchSessionByIdCompat({ token: credentials.token, sessionId: parentSessionId });
    } catch (error) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: error instanceof Error ? error.message : 'Failed to load parent session',
      };
    }
    if (!parentSession) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Session not found',
      };
    }

    const parentMetadata = tryDecryptSessionMetadata({
      credentials,
      rawSession: parentSession,
    });
    if (!parentMetadata) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to decrypt session metadata',
      };
    }

    const directory = typeof parentMetadata.path === 'string' && parentMetadata.path.trim().length > 0
      ? parentMetadata.path.trim()
      : '';
    if (!directory) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Session metadata missing path',
      };
    }

    const forkBackendResolution = await resolveSessionForkBackendTarget({
      parentMetadata,
      credentials,
    });
    if (!forkBackendResolution.ok) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: forkBackendResolution.errorMessage,
      };
    }

    const openCodeParentAffinity =
      forkBackendResolution.providerAgentId === 'opencode'
        ? readOpenCodeSessionAffinityFromMetadata(parentMetadata)
        : null;
    const inheritedForkOverrides = resolveForkInheritedOverridesFromMetadata(parentMetadata);

    const targetSeqInclusive = forkPoint.type === 'seq'
      ? forkPoint.upToSeqInclusive
      : (typeof (parentSession as any)?.seq === 'number' && Number.isFinite((parentSession as any).seq) ? Math.max(0, Math.floor((parentSession as any).seq)) : 0);

    // Branch-and-edit semantics: when the fork target is a user message, the child session should
    // start from the state *before* that user message, while restoring the message as an editable draft.
    // Providers with native fork support (e.g. OpenCode) still need the original user-message seq
    // to resolve vendor message ids correctly.
    const cutoffSeqInclusive = forkPoint.type === 'seq'
      ? (() => {
        // Default to inclusive cutoff; adjust to exclusive for user messages when detectable.
        return targetSeqInclusive;
      })()
      : targetSeqInclusive;

    const resolvedCutoff = forkPoint.type === 'seq'
      ? await resolveForkCutoffSeqInclusive({
        credentials,
        parentSessionId,
        parentRawSession: parentSession,
        targetSeqInclusive,
      }).catch(() => null)
      : null;

    const effectiveCutoffSeqInclusive =
      forkPoint.type === 'seq' && resolvedCutoff
        ? resolvedCutoff.cutoffSeqInclusive
        : cutoffSeqInclusive;

    // Spawn request coalescing dedupes identical spawn fingerprints within a short window. Forking must
    // be able to create multiple sessions quickly (e.g. multi-level fork chains), so provide a
    // fork-specific nonce to guarantee unique spawn keys without leaking extra env vars to the child.
    const spawnNonce = `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`;

    const maxTextChars = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);

    const shouldAttemptProviderNative =
      (requestedStrategy === 'auto' || requestedStrategy === 'provider_native');

    if (shouldAttemptProviderNative) {
      try {
        const nativeFork = await dispatchProviderNativeFork({
          credentials,
          agentId: forkBackendResolution.providerAgentId,
          parentSessionId,
          parentRawSession: parentSession,
          parentMetadata,
          directory,
          forkPoint: forkPoint.type === 'seq'
            ? { type: 'seq', upToSeqInclusive: targetSeqInclusive }
            : { type: 'latest' },
          targetSeqInclusive,
        });

        if (nativeFork) {
          const result = await spawnSession({
            directory,
            backendTarget: forkBackendResolution.backendTarget,
            approvedNewDirectoryCreation: true,
            spawnNonce,
            ...nativeFork.spawn,
            ...inheritedForkOverrides.spawn,
          } satisfies SpawnSessionOptions);

          if (requestedStrategy === 'provider_native' && result.type !== 'success') {
            return {
              ok: false,
              errorCode: (result as any)?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
              errorMessage: (result as any)?.errorMessage ?? 'Failed to spawn provider-native fork session',
            };
          }

          if (result.type === 'success' && result.sessionId) {
            const childSessionId = result.sessionId;
            if (childSessionId === parentSessionId) {
              return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
            }
            try {
              const childRaw = await fetchForkChildSessionOrThrow({ token: credentials.token, sessionId: childSessionId });
              await updateSessionMetadataWithRetry({
                token: credentials.token,
                credentials,
                sessionId: childSessionId,
                rawSession: childRaw,
                updater: (metadata) => ({
                  ...metadata,
                  ...inheritedForkOverrides.metadata,
                  ...forkBackendResolution.metadataOverlay,
                  ...nativeFork.metadata,
                  forkV1: {
                    v: 1,
                    parentSessionId,
                    parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                    createdAtMs: Date.now(),
                    strategy: 'provider_native',
                    providerHint: nativeFork.providerHint,
                  },
                }),
                maxAttempts: 6,
              });
            } catch (error) {
              await cleanupForkChildBestEffort(stopSession, childSessionId);
              await archiveSessionBestEffort(credentials.token, childSessionId);
              return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
              };
            }
            return { ok: true, childSessionId };
          }
        }
      } catch (error) {
        if (requestedStrategy === 'provider_native') {
          return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Provider-native fork failed',
          };
        }
      }
    }

    const shouldAttemptAcpForkLatest =
      (requestedStrategy === 'auto' || requestedStrategy === 'acp_fork_latest') &&
      (forkPoint.type === 'latest') &&
      (
        forkBackendResolution.configuredAcp !== null ||
        isAcpForkEligibleForProvider({
          providerId: forkBackendResolution.providerAgentId,
          metadata: parentMetadata,
        })
      );

    if (shouldAttemptAcpForkLatest) {
      // Best-effort ACP fork: only applies when the parent session can be resumed as an ACP session.
      // If unsupported, fall back to replay fork below.
      try {
        const vendorSessionIdRaw =
          forkBackendResolution.configuredAcp?.vendorSessionId ??
          resolveVendorResumeIdFromSessionMetadata(forkBackendResolution.providerAgentId as any, parentMetadata) ??
          '';

        if (vendorSessionIdRaw) {
          const permissionHandler = {
            handleToolCall: async () => ({ decision: 'denied' as const }),
          };
          let acpBackend: {
            loadSession?: (sessionId: string) => Promise<unknown>;
            forkSession?: (params: Readonly<{ sessionId: string; cwd?: string }>) => Promise<unknown>;
            dispose: () => Promise<unknown>;
          } | null = null;

          if (forkBackendResolution.configuredAcp?.resolvedBackend && forkBackendResolution.configuredAcp.accountSettings) {
            const { createConfiguredAcpBackend } = await import('@/agent/acp/catalog/configured/createConfiguredAcpBackend');
            const { materializeConfiguredAcpEnvironment } = await import('@/agent/acp/catalog/configured/materializeConfiguredAcpEnvironment');
            const launchEnv = materializeConfiguredAcpEnvironment({
              backend: forkBackendResolution.configuredAcp.resolvedBackend,
              accountSettings: forkBackendResolution.configuredAcp.accountSettings,
              credentials,
            });
            acpBackend = createConfiguredAcpBackend({
              cwd: directory,
              backend: forkBackendResolution.configuredAcp.resolvedBackend,
              launchEnv,
              mcpServers: {},
              permissionHandler,
            }) as unknown as NonNullable<typeof acpBackend>;
          } else if (!forkBackendResolution.configuredAcp) {
            const { createCatalogAcpBackend } = await import('@/agent/acp/createCatalogAcpBackend');
            const created = await createCatalogAcpBackend(forkBackendResolution.providerAgentId as any, {
              cwd: directory,
              mcpServers: {},
              permissionHandler,
            } as any);
            acpBackend = created.backend;
          }

          try {
            if (acpBackend && typeof acpBackend.loadSession === 'function' && typeof acpBackend.forkSession === 'function') {
              await acpBackend.loadSession(vendorSessionIdRaw);
              const forked = await acpBackend.forkSession({
                sessionId: vendorSessionIdRaw,
              });
              const forkedRecord = (forked && typeof forked === 'object') ? forked as { sessionId?: unknown } : null;
              const forkedSessionId = typeof forkedRecord?.sessionId === 'string'
                ? String(forkedRecord.sessionId).trim()
                : '';
              if (forkedSessionId) {
                const acpForkContinuation = await getAcpForkContinuationHandler(forkBackendResolution.providerAgentId);
                const continuationShape = acpForkContinuation
                  ? await acpForkContinuation({
                    agentId: forkBackendResolution.providerAgentId,
                    parentMetadata,
                    vendorSessionId: forkedSessionId,
                  })
                  : null;

                const result = await spawnSession({
                  directory,
                  backendTarget: forkBackendResolution.backendTarget,
                  approvedNewDirectoryCreation: true,
                  resume: forkedSessionId,
                  ...(continuationShape?.spawn ?? {}),
                  ...inheritedForkOverrides.spawn,
                } satisfies SpawnSessionOptions);

                if (requestedStrategy === 'acp_fork_latest' && result.type !== 'success') {
                  return {
                    ok: false,
                    errorCode: (result as any)?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: (result as any)?.errorMessage ?? 'Failed to spawn ACP fork session',
                  };
                }

                if (result.type === 'success' && result.sessionId) {
                  const childSessionId = result.sessionId;
                  if (childSessionId === parentSessionId) {
                    return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
                  }
                  try {
                    const childRaw = await fetchForkChildSessionOrThrow({ token: credentials.token, sessionId: childSessionId });
                    await updateSessionMetadataWithRetry({
                      token: credentials.token,
                      credentials,
                      sessionId: childSessionId,
                      rawSession: childRaw,
                      updater: (metadata) => ({
                        ...metadata,
                        ...inheritedForkOverrides.metadata,
                        ...forkBackendResolution.metadataOverlay,
                        ...(continuationShape?.metadata ?? {}),
                        forkV1: {
                          v: 1,
                          parentSessionId,
                          parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                          createdAtMs: Date.now(),
                          strategy: 'acp_fork_latest',
                          providerHint: continuationShape?.providerHint ?? {
                            providerId: forkBackendResolution.providerHintAgentId,
                            vendorSessionId: forkedSessionId,
                          },
                        },
                      }),
                        maxAttempts: 6,
                      });
                  } catch (error) {
                    await cleanupForkChildBestEffort(stopSession, childSessionId);
                    await archiveSessionBestEffort(credentials.token, childSessionId);
                    return {
                      ok: false,
                      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                      errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
                    };
                  }
                  return { ok: true, childSessionId };
                }
              }
            }
          } finally {
            if (acpBackend) {
              await acpBackend.dispose().catch(() => {});
            }
          }
        }
      } catch {
        // Ignore and fall back to replay fork below.
      }
    }

    if (requestedStrategy !== 'auto' && requestedStrategy !== 'replay') {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Requested fork strategy is not supported',
      };
    }

    const replaySummaryRunner = parsed.data.replaySummaryRunner;

    const resolvedSeed = await resolveReplaySeedDraft({
      credentials,
      cwd: directory,
      source: {
        kind: 'fork_chain',
        previousSessionId: parentSessionId,
        ...(forkPoint.type === 'seq' ? { upToSeqInclusive: effectiveCutoffSeqInclusive } : {}),
      },
      strategy: replaySummaryRunner ? 'summary_plus_recent' : 'recent_messages',
      recentMessagesCount: configuration.replaySeedCandidateLimit,
      maxSeedChars: typeof parsed.data.replayMaxSeedChars === 'number' ? parsed.data.replayMaxSeedChars : configuration.replaySeedMaxChars,
      candidateLimit: configuration.replaySeedCandidateLimit,
      maxTextChars: maxTextChars ?? undefined,
      summaryRunner: replaySummaryRunner ?? null,
      deps: params.deps?.runReplaySummaryForDialog
        ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
        : undefined,
    });
    if (!resolvedSeed) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to hydrate replay dialog from transcript.',
      };
    }
    const seedDraft = resolvedSeed.seedDraft;

    if (!seedDraft.trim()) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Replay seed draft is empty',
      };
    }

    const nowMs = Date.now();
    const created = await (async () => {
      try {
        return await createReplaySeededSession({
          credentials,
          directory,
          flavor: forkBackendResolution.replayFlavor,
          tag: `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`,
          metadata: {
            ...inheritedForkOverrides.metadata,
            ...forkBackendResolution.metadataOverlay,
            ...(forkBackendResolution.providerAgentId === 'opencode'
              ? applyOpenCodeSessionAffinityMetadata({
                backendMode: openCodeParentAffinity?.backendMode ?? 'server',
                serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
                serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
              })
              : {}),
            forkV1: {
              v: 1,
              parentSessionId,
              parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
              createdAtMs: nowMs,
              strategy: 'replay',
              providerHint: { providerId: forkBackendResolution.providerHintAgentId },
            },
            replaySeedV1: {
              v: 1,
              seedText: seedDraft,
              sourceSessionId: parentSessionId,
              sourceCutoffSeqInclusive: effectiveCutoffSeqInclusive,
              createdAtMs: nowMs,
            },
          },
        });
      } catch (error) {
        logger.debug('[API MACHINE] Failed to create fork session for replay', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (!created) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to create fork session',
      };
    }

    const spawnResult = await spawnSession({
      directory,
      backendTarget: forkBackendResolution.backendTarget,
      approvedNewDirectoryCreation: true,
      spawnNonce,
      existingSessionId: created.sessionId,
      ...(forkBackendResolution.providerAgentId === 'opencode'
        ? {
          environmentVariables: buildOpenCodeSessionEnvironmentVariables({
            backendMode: openCodeParentAffinity?.backendMode ?? 'server',
            serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
            serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
          }),
        }
        : {}),
      ...inheritedForkOverrides.spawn,
    } satisfies SpawnSessionOptions);

    if (spawnResult.type !== 'success') {
      await archiveSessionBestEffort(credentials.token, created.sessionId);
      return {
        ok: false,
        errorCode: (spawnResult as any)?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: (spawnResult as any)?.errorMessage ?? 'Failed to spawn fork session',
      };
    }

    if (created.sessionId === parentSessionId) {
      return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
    }

    return { ok: true, childSessionId: created.sessionId };
  });

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

  // Register stop session handler
  rpcHandlerManager.registerHandler(RPC_METHODS.STOP_SESSION, async (params: any) => {
    const { sessionId } = params || {};

    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    const success = await stopSession(sessionId);
    if (!success) {
      throw new Error('Session not found or failed to stop');
    }

    logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
    return { message: 'Session stopped' };
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

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_LOG_TAIL, async (params: any) => {
    const maxBytes = typeof params?.maxBytes === 'number' && Number.isFinite(params.maxBytes)
      ? Math.min(Math.max(Math.floor(params.maxBytes), 1024), 1_000_000)
      : 200_000;
    const path = typeof params?.path === 'string' && params.path.trim().length > 0 ? params.path.trim() : '';
    if (!path) {
      return {
        success: false,
        error: 'Session log path is required',
      };
    }
    if (!path.toLowerCase().endsWith('.log')) {
      return {
        success: false,
        error: 'Session log path must point to a .log file',
      };
    }

    const canonicalRequestedPath = await toCanonicalPath(path);
    if (!canonicalRequestedPath) {
      return {
        success: false,
        error: 'Session log path is unavailable on this machine',
      };
    }

    const canonicalHappyHomeDir = await toCanonicalPath(resolve(configuration.happyHomeDir));
    if (!canonicalHappyHomeDir) {
      return {
        success: false,
        error: 'Happy home directory is unavailable for log validation',
      };
    }

    const allowedRoots = [
      resolve(canonicalHappyHomeDir, 'logs'),
      resolve(canonicalHappyHomeDir, 'stacks'),
    ];
    if (!allowedRoots.some((dir) => isPathInside(canonicalRequestedPath, dir))) {
      return {
        success: false,
        error: 'Requested log path is outside allowed Happier directories',
      };
    }

    try {
      const fileStat = await stat(canonicalRequestedPath);
      const tail = await readBugReportLogTail(canonicalRequestedPath, maxBytes);
      return {
        success: true,
        path: canonicalRequestedPath,
        tail,
        truncated: fileStat.size > maxBytes,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, async () => {
    return await collectBugReportMachineDiagnosticsSnapshotForBugReport();
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_GET_LOG_TAIL, async (params: any) => {
    const maxBytes = typeof params?.maxBytes === 'number' && Number.isFinite(params.maxBytes)
      ? Math.min(Math.max(Math.floor(params.maxBytes), 1024), 1_000_000)
      : 200_000;
    const path = typeof params?.path === 'string' && params.path.trim().length > 0 ? params.path.trim() : '';
    const diagnostics = await collectBugReportMachineDiagnosticsSnapshotForBugReport();
    const allowedPaths = new Set<string>();
    if (diagnostics.daemonState?.daemonLogPath) {
      allowedPaths.add(diagnostics.daemonState.daemonLogPath.trim());
    }
    for (const entry of diagnostics.daemonLogs) {
      if (typeof entry.path === 'string' && entry.path.trim().length > 0) {
        allowedPaths.add(entry.path.trim());
      }
    }
    for (const entry of diagnostics.stackContext?.logCandidates ?? []) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        allowedPaths.add(entry.trim());
      }
    }

    const canonicalAllowedPaths = new Set<string>();
    for (const candidatePath of allowedPaths) {
      const canonicalPath = await toCanonicalPath(candidatePath);
      if (canonicalPath) {
        canonicalAllowedPaths.add(canonicalPath);
      }
    }

    let canonicalRequestedPath: string | null = null;
    if (path) {
      canonicalRequestedPath = await toCanonicalPath(path);
      if (!canonicalRequestedPath || !canonicalAllowedPaths.has(canonicalRequestedPath)) {
        return {
          ok: false,
          error: 'Requested log path is not allowed for bug report diagnostics',
        };
      }
    }

    const fallbackPath = Array.from(canonicalAllowedPaths)[0] ?? null;
    const targetPath = canonicalRequestedPath ?? fallbackPath;
    if (!targetPath) {
      return {
        ok: false,
        error: 'No daemon log path available',
      };
    }

    try {
      const tail = await readBugReportLogTail(targetPath, maxBytes);
      return {
        ok: true,
        path: targetPath,
        tail,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT, async (params: any) => {
    // Upload is intentionally delegated to UI/service clients via pre-signed URLs.
    // Keep the RPC for capability negotiation and future transport optimizations.
    return {
      ok: false,
      error: 'Daemon-side upload is not enabled; upload via report service pre-signed URL from UI.',
      uploadUrl: typeof params?.uploadUrl === 'string' ? params.uploadUrl : null,
    };
  });

  return {
    transferRelayV2DownloadOwners,
  };
}
