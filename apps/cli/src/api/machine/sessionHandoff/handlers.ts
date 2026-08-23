import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import {
  ExternalSessionsSourceSchema,
  type MachineTransferReceiveEnvelope,
  type MachineTransferSendEnvelope,
  MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY,
  type RuntimeDescriptorV1,
  type SessionHandoffResumePlan,
  type WorkspaceManifest,
} from '@happier-dev/protocol';
import {
  registerServerRoutedTransferResponder,
  requestServerRoutedTransferToFile,
  resolveServerRoutedTransferTimeoutMs,
  type MachineTransferChannel,
  ServerRoutedInvalidOpenRequestError,
  ServerRoutedAbortTransferError,
} from '../../../machines/transfer/serverRoutedTransport';
import { rewriteDirectPeerEndpointCandidatesForTransferId } from '../../../machines/transfer/rewriteDirectPeerEndpointCandidatesForTransferId';
import { createMachineTransferRouteCache } from '../../../machines/transfer/transferRouteCache';
import {
  disposeTransferPayloadSource,
  createFileTransferPayloadSource,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  type TransferPayloadSource,
} from '../../../machines/transfer/transferPayloadSource';
import {
  exportSessionHandoffState,
} from '../../../session/handoff/exportSessionHandoffState';
import { importSessionHandoffAgentBundle } from '../../../session/handoff/agentBundle/import';
import {
  resolveSessionHandoffExportMetadata,
  type SessionHandoffLocalMetadataSource,
} from '../../../session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import {
  readSessionHandoffAgentBundleFile,
} from '../../../session/handoff/agentBundle/file';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  parseSessionHandoffAgentBundleTransferId,
  type SessionHandoffAgentBundleTransferPublication
} from '../../../session/handoff/agentBundle/transferPublication';
import {
  createSessionHandoffWorkspaceReplicationAdapter,
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
  parseSessionHandoffWorkspaceBlobPackTransferId,
  resolveSessionHandoffWorkspaceReplicationSourceOffer,
  type SessionHandoffWorkspaceReplicationMetadata,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';
import {
  parseSessionHandoffWorkspaceManifestTransferId
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';
import { readWorkspaceReplicationManifestFromFile } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/manifestFile';
import { parseWorkspaceReplicationBlobPackRequestV1 } from '../../../workspaces/replication/transport/workspaceReplicationBlobPackRequestV1';
import { buildWorkspaceReplicationManifestDigestIndex } from '../../../workspaces/replication/transport/workspaceReplicationManifestIndex';
import { assertWorkspaceReplicationBlobPackRequestWithinLimits } from '../../../workspaces/replication/transport/blobPackRequestWithinLimits';
import {
  createSessionHandoffPrepareTargetJobStore,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import {
  resolveSessionHandoffPrepareTargetJobLeaseTtlMs,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobLease';

import type { RpcHandlerManager } from '../../rpc/RpcHandlerManager';
import {
  createSessionLifecycleRpcActionExecutor,
  registerSessionLifecycleRpcHandlers,
  SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
} from '@/rpc/handlers/sessionLifecycle';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import {
  directPeerTransferUnavailable,
  isSessionHandoffDirectPeerProtocolError,
  resolvePrepareAgentBundle,
  resolvePrepareWorkspaceReplicationMetadata,
  type SessionHandoffDirectPeerTransferHandle,
} from './prepareTransport';
import { createSessionHandoffStartActionHandler } from './start';
import {
  prepareStartedState as prepareStartedStateCore,
  type PrepareStartedStateCallInput,
} from './prepareStartedState';
import { createSessionHandoffPrepareTargetActionHandler } from './prepareTarget';
import { createSessionHandoffCommitActionHandler } from './commit';
import { createSessionHandoffAbortActionHandler } from './abort';
import { createSessionHandoffStatusGetActionHandler } from './statusGet';
import { createSessionHandoffPrepareTargetResultGetActionHandler } from './prepareTargetResultGet';
import { createSessionHandoffPrepareTargetResumeActionHandler } from './prepareTargetResume';
import {
  buildPrepareJobRecord,
  buildStartPendingStatus,
  buildStartRecoveryStatus,
  buildSourceExportOnlyPrepareJobId,
  invalidRequest,
  isTerminalHandoffStatus,
  readPersistedPrepareJob,
  resolveWorkspaceReplicationHandoffBackTargetRootPath,
} from './prepareTargetState';
import {
  readSessionHandoffRuntimeConfig,
  type SessionHandoffRuntimeConfig,
} from './runtimeConfig';
import {
  registerSessionHandoffPredecessorCompatibilityHandlers,
} from './predecessorCompatibility';
import {
  createExternalSessionOperationExclusion,
  type ExternalSessionOperationClaimMaintenance,
  type ExternalSessionOperationExclusionOwner,
} from '@/session/external/operationExclusion';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '../../../session/shared/spawnSessionContract';
import type { RegisterActionSpecRpcHandlersParams } from '@/rpc/handlers/registerActionSpecRpcHandlers';

export type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';

type SessionHandoffExportBundleResult = Readonly<{
  agentBundle: SessionHandoffAgentBundle;
  targetPath: string;
}>;

type SessionHandoffWorkspaceReplicationAdapter = ReturnType<
  typeof createSessionHandoffWorkspaceReplicationAdapter
>;

export type SessionHandoffRuntimeDependencies = Readonly<{
  createUuid: () => string;
  exportSessionHandoffState: typeof exportSessionHandoffState;
  workspaceReplicationAdapter: SessionHandoffWorkspaceReplicationAdapter;
}>;

function isMachineTransferTimeoutErrorMessage(message: string): boolean {
  return message.startsWith('Timed out waiting for machine transfer ');
}

export function registerMachineSessionHandoffRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  sessionOperationExclusion?: ExternalSessionOperationExclusionOwner;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  loadSessionMetadata?: (sessionId: string) => Promise<Record<string, unknown> | null>;
  savePreparedTargetLocalMetadata?: (input: Readonly<{
    remoteSessionId: string;
    exportMetadataOverlay: Record<string, unknown>;
  }>) => Promise<void> | void;
  stopSessionForHandoff?: (sessionId: string) => Promise<'stopped' | 'already_inactive' | 'failed'>;
  spawnSessionForHandoff?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  exportSessionBundle?: (metadata: Record<string, unknown>) => Promise<Readonly<{
    agentBundle: SessionHandoffAgentBundle;
    targetPath: string;
  }>>;
  importSessionBundle?: (bundle: SessionHandoffAgentBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    resume: SessionHandoffResumePlan;
  }>>;
  machineTransferChannel?: MachineTransferChannel;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  runtimeConfig?: SessionHandoffRuntimeConfig;
  runtimeDependencies?: Partial<SessionHandoffRuntimeDependencies>;
  observeExecution?: RegisterActionSpecRpcHandlersParams['observeExecution'];
  coordinateSessionHandoff?: (input: Readonly<{
    actionInput: unknown;
    start: () => Promise<import('@happier-dev/protocol/actions').ActionExecuteResult>;
    signal: AbortSignal;
    publishOwnerUpdate: (update: import('@/daemon/actionOperations').ActionOperationOwnerUpdate) => void;
  }>) => Promise<import('@happier-dev/protocol/actions').ActionExecuteResult>;
}>): void {
  const runtimeConfig = params.runtimeConfig ?? readSessionHandoffRuntimeConfig();
  const createUuid = params.runtimeDependencies?.createUuid ?? randomUUID;
  const exportHandoffState = params.runtimeDependencies?.exportSessionHandoffState ?? exportSessionHandoffState;
  const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
    activeServerDir: runtimeConfig.activeServerDir,
  });
  const sourceExportStore = createSessionHandoffSourceExportStore({
    activeServerDir: runtimeConfig.activeServerDir,
  });
  const activePrepareJobs = new Map<string, Promise<void>>();
  const prepareTargetJobLeaseOwnerId = `cli-daemon:${process.pid}:${createUuid()}`;
  const sessionOperationExclusion = params.sessionOperationExclusion
    ?? createExternalSessionOperationExclusion({
      activeServerDir: runtimeConfig.activeServerDir,
      ownerId: `cli-daemon:${process.pid}:session-operations:${createUuid()}`,
    });
  const activeHandoffOperationClaims = new Map<string, Readonly<{
    maintenance: ExternalSessionOperationClaimMaintenance;
  }>>();
  const retainSessionOperationClaim = (
    handoffId: string,
    maintenance: ExternalSessionOperationClaimMaintenance,
  ): void => {
    activeHandoffOperationClaims.set(handoffId, { maintenance });
  };
  const releaseSessionOperationClaim = async (handoffId: string): Promise<void> => {
    const active = activeHandoffOperationClaims.get(handoffId);
    if (!active) return;
    activeHandoffOperationClaims.delete(handoffId);
    active.maintenance.stop();
    await active.maintenance.claim.release().catch(() => undefined);
  };
  const prepareTargetJobLeaseTtlMs = resolveSessionHandoffPrepareTargetJobLeaseTtlMs();
  const { rpcHandlerManager } = params;
  const NO_MACHINE_TRANSFER_CHANNEL_CACHE_KEY = '__no_machine_transfer_channel__';
  const transferRouteCachesByServerId = new Map<string, ReturnType<typeof createMachineTransferRouteCache>>();
  const getTransferRouteCache = (
    machineTransferChannel: Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel'],
  ): ReturnType<typeof createMachineTransferRouteCache> => {
    if (!machineTransferChannel) {
      const existingNoChannelCache = transferRouteCachesByServerId.get(NO_MACHINE_TRANSFER_CHANNEL_CACHE_KEY);
      if (existingNoChannelCache) {
        return existingNoChannelCache;
      }
      const createdNoChannelCache = createMachineTransferRouteCache({
        serverId: NO_MACHINE_TRANSFER_CHANNEL_CACHE_KEY,
      });
      transferRouteCachesByServerId.set(NO_MACHINE_TRANSFER_CHANNEL_CACHE_KEY, createdNoChannelCache);
      return createdNoChannelCache;
    }
    const rawServerId = typeof machineTransferChannel?.serverId === 'string'
      ? machineTransferChannel.serverId.trim()
      : '';
    if (rawServerId.length === 0) {
      // Some mixed-version or bridge-state channels do not expose a stable server id yet.
      // In that case, avoid poisoning the active-server cache with a guess and keep the cache
      // isolated to this handler invocation instead.
      return createMachineTransferRouteCache({
        serverId: `unknown:${process.pid}:${createUuid()}`,
      });
    }
    const serverId = rawServerId;
    const existingCache = transferRouteCachesByServerId.get(serverId);
    if (existingCache) {
      return existingCache;
    }
    const createdCache = createMachineTransferRouteCache({ serverId });
    transferRouteCachesByServerId.set(serverId, createdCache);
    return createdCache;
  };
  getTransferRouteCache(params.machineTransferChannel);
  const invalidateDirectPeerRouteCacheForHandoffMachines = (machineIds: readonly (string | undefined)[]): void => {
    for (const machineId of machineIds) {
      const normalizedMachineId = typeof machineId === 'string' ? machineId.trim() : '';
      if (!normalizedMachineId) {
        continue;
      }
      for (const transferRouteCache of transferRouteCachesByServerId.values()) {
        transferRouteCache.invalidateDirectPeerRoutesForMachine(normalizedMachineId);
      }
    }
  };
  const workspaceReplicationAdapter = params.runtimeDependencies?.workspaceReplicationAdapter
    ?? createSessionHandoffWorkspaceReplicationAdapter();
  const workspaceReplicationTransfers = workspaceReplicationAdapter.createReplicationTransfers(
    params.directPeerTransfer
      ? {
          requestDirectPeerTransferToFile: async ({
            transferId,
            endpointCandidates,
            destinationPath,
            openBody,
            timeoutMs,
          }) => {
            const maxAttempts = 12;
            const retryDelayMs = 250;
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
              const requestPayloadFile = params.directPeerTransfer?.requestPayloadFile;
              if (requestPayloadFile) {
                const received = await requestPayloadFile({
                  transferId,
                  endpointCandidates,
                  destinationPath,
                  ...(openBody !== undefined ? { openBody } : {}),
                  ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
                });
                const payloadSource = createFileTransferPayloadSource({
                  filePath: received.destinationPath,
                });
                return {
                  destinationPath: received.destinationPath,
                  manifestHash: await resolveTransferPayloadManifestHash(payloadSource),
                  sizeBytes: await resolveTransferPayloadSizeBytes(payloadSource),
                };
              }
              if (attempt < maxAttempts) {
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, retryDelayMs * attempt);
                });
              }
            }
            throw new Error(directPeerTransferUnavailable().error);
          },
        }
      : {},
  );
  const ephemeralServerRoutedPayloadSources = new Map<string, TransferPayloadSource>();

		  const waitForPersistedSourceExport = async (
		    handoffId: string,
		    predicate: (record: NonNullable<Awaited<ReturnType<typeof sourceExportStore.load>>>) => boolean,
		    transferTimeoutMsOverride?: number,
		  ): Promise<Awaited<ReturnType<typeof sourceExportStore.load>> | null> => {
	    const resolveTerminalAbortReason = (message?: string): string => {
	      const trimmed = typeof message === 'string' ? message.trim() : '';
	      const ineligibleMatch = /^Session is not eligible for handoff: ([a-z0-9_]+)$/u.exec(trimmed);
	      if (ineligibleMatch) {
	        return `handoff_ineligible:${ineligibleMatch[1]}`;
	      }
	      return 'handoff_source_export_failed';
	    };

	      // Waiting for a source-export record is not the same as "session TTL", but it *must* be long
	      // enough to cover deferred export on large repos.
	      //
	      // Important: server-routed transfers have a per-transfer timeout for the open/ack/chunk
	      // handshake. This wait budget must be derived from that timeout, not from unrelated
	      // app↔daemon file-transfer TTLs, or deferred exports can abort with `transfer_not_found`
	      // while still pending.
		      const baseTransferTimeoutMs =
		        typeof transferTimeoutMsOverride === 'number' && Number.isFinite(transferTimeoutMsOverride) && transferTimeoutMsOverride > 0
		          ? transferTimeoutMsOverride
		          : resolveServerRoutedTransferTimeoutMs();
		      // Keep the wait budget within the transfer-level timeout so requesters still receive a
		      // response (chunk or abort) before their own inactivity timer fires.
		      const timeoutMs = Math.max(1, Math.floor(baseTransferTimeoutMs) - 100);
		      const deadlineAtMs = Date.now() + timeoutMs;
			    let delayMs = 25;
	    while (Date.now() < deadlineAtMs) {
	      const record = await sourceExportStore.load(handoffId);
	      if (record && predicate(record)) {
	        return record;
	      }

	      const prepareJob = await prepareJobStore.findByHandoffId(handoffId).catch(() => null);
	      if (prepareJob && isTerminalHandoffStatus(prepareJob.status)) {
	        throw new ServerRoutedAbortTransferError(resolveTerminalAbortReason(prepareJob.lastErrorMessage));
	      }
		      await new Promise<void>((resolve) => {
		        setTimeout(resolve, delayMs);
		      });
		      delayMs = Math.min(2_000, Math.floor(delayMs * 1.5));
		    }
		    return null;
		  };

      const resolveServerRoutedTransferTimeoutMsOverrideFromOpenPayload = (openPayload: unknown): number | undefined => {
        if (!openPayload || typeof openPayload !== 'object' || Array.isArray(openPayload)) {
          return undefined;
        }
        const raw = (openPayload as Record<string, unknown>).timeoutMs;
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          return undefined;
        }
        const floored = Math.floor(raw);
        if (floored <= 0) {
          return undefined;
        }
        // Mirror the server-routed transport hard max to avoid hostile open payloads pinning the responder for too long.
        return Math.min(floored, 30 * 60_000);
      };

  const disposeEphemeralServerRoutedPayloadSourcesForHandoff = async (handoffId: string): Promise<void> => {
    for (const [transferId, payloadSource] of [...ephemeralServerRoutedPayloadSources.entries()]) {
      const blobPackTransfer = parseSessionHandoffWorkspaceBlobPackTransferId(transferId);
      const manifestTransfer = parseSessionHandoffWorkspaceManifestTransferId(transferId);
      if (
        blobPackTransfer?.handoffId !== handoffId
        && manifestTransfer?.handoffId !== handoffId
      ) {
        continue;
      }
      ephemeralServerRoutedPayloadSources.delete(transferId);
      await disposeTransferPayloadSource(payloadSource).catch(() => undefined);
    }
  };
  const loadRemoteSessionMetadata =
    params.loadSessionMetadata ??
    (async (sessionId: string): Promise<Record<string, unknown> | null> => {
      const [
        { readStoredCredentials },
        { fetchSessionById },
        { tryDecryptSessionOwnerMetadataView },
        { fetchAccountEncryptionCurrentness },
      ] = await Promise.all([
        import('../../../persistence'),
        import('@/session/transport/http/sessionsHttp'),
        import('@/session/transport/encryption/sessionEncryptionContext'),
        import('@/api/client/connectedServiceCredentialApi'),
      ]);
      const credentials = await readStoredCredentials().catch(() => null);
      if (!credentials) return null;
      const [rawSession, accountEncryptionCurrentness] = await Promise.all([
        fetchSessionById({ token: credentials.token, sessionId }).catch(() => null),
        fetchAccountEncryptionCurrentness({ token: credentials.token }).catch(() => null),
      ]);
      if (!rawSession || !accountEncryptionCurrentness) return null;
      const metadata = tryDecryptSessionOwnerMetadataView({
        credentials,
        rawSession,
        accountEncryptionMode: accountEncryptionCurrentness.mode,
      });
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null;
    });
  const loadLocalSessionMetadata =
    params.loadLocalSessionMetadata ??
    (async (): Promise<SessionHandoffLocalMetadataSource | null> => null);
  const loadSessionMetadata = async (
    sessionId: string,
    sourceMachineId?: string,
  ): Promise<Record<string, unknown> | null> => {
    const [localMetadata, remoteMetadata] = await Promise.all([
      loadLocalSessionMetadata(sessionId),
      loadRemoteSessionMetadata(sessionId),
    ]);
    return resolveSessionHandoffExportMetadata({
      remoteMetadata,
      localMetadata,
      ...(sourceMachineId ? { preferredLocalExportMachineId: sourceMachineId } : {}),
    });
  };
  const exportSessionBundle: (metadata: Record<string, unknown>) => Promise<SessionHandoffExportBundleResult> =
    params.exportSessionBundle ??
    (async (metadata: Record<string, unknown>) => {
      return await exportHandoffState({
        metadata,
        activeServerDir: runtimeConfig.activeServerDir,
      });
    });
  const importSessionBundle =
    params.importSessionBundle ??
    (async (bundle: SessionHandoffAgentBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') =>
      await importSessionHandoffAgentBundle({
        bundle,
        targetPath,
        sessionStorageMode,
      }));
  const prepareStartedState = async (
    callInput: PrepareStartedStateCallInput,
  ) => {
    return await prepareStartedStateCore({
      callInput,
      activeServerDir: runtimeConfig.activeServerDir,
      exportSessionBundle,
      sourceExportStore,
      workspaceReplicationAdapter,
      directPeerTransfer: params.directPeerTransfer,
      resolveWorkspaceReplicationHandoffBackTargetRootPath,
      buildStartPendingStatus,
    });
  };

	  if (params.machineTransferChannel) {
	    registerServerRoutedTransferResponder({
	      machineTransferChannel: params.machineTransferChannel,
	      loadTransferPayloadSource: async (request) => {
	        const transferId = request.transferId;
	        const cachedPayloadSource = ephemeralServerRoutedPayloadSources.get(transferId);
	      if (cachedPayloadSource) {
	        return cachedPayloadSource;
	      }

          const transferTimeoutMsOverride =
            resolveServerRoutedTransferTimeoutMsOverrideFromOpenPayload(request.openPayload);

		        const workspaceBlobPackTransfer = parseSessionHandoffWorkspaceBlobPackTransferId(transferId);
		        if (workspaceBlobPackTransfer) {
		          const openBody = parseWorkspaceReplicationBlobPackRequestV1(request.openPayload, {
	              maxBlobs: runtimeConfig.workspaceReplicationBlobPackMaxBlobs,
	            });
		          if (!openBody || openBody.packId !== workspaceBlobPackTransfer.packId) {
		            throw new ServerRoutedInvalidOpenRequestError('Invalid workspace blob-pack open payload');
		          }
	              const persistedSourceExport = await waitForPersistedSourceExport(
	                workspaceBlobPackTransfer.handoffId,
	                (record) => Boolean(record.workspaceManifest),
                  transferTimeoutMsOverride,
	              );
	              if (!persistedSourceExport?.workspaceManifest) {
	                return null;
	              }

	              let manifest: WorkspaceManifest;
	              try {
	                manifest = await readWorkspaceReplicationManifestFromFile({
	                  transferId: persistedSourceExport.workspaceManifest.transferId,
	                  filePath: persistedSourceExport.workspaceManifest.filePath,
	                  sizeBytes: persistedSourceExport.workspaceManifest.sizeBytes,
	                });
	              } catch {
	                throw new ServerRoutedAbortTransferError('workspace_replication_source_error');
	              }
	              const digestIndex = buildWorkspaceReplicationManifestDigestIndex(manifest);
	              try {
	                assertWorkspaceReplicationBlobPackRequestWithinLimits({
	                  digestIndex,
                  digests: openBody.digests,
                  blobPackTargetBytes: runtimeConfig.workspaceReplicationBlobPackTargetBytes,
                  blobPackMaxSingleBlobBytes: runtimeConfig.workspaceReplicationBlobPackMaxSingleBlobBytes,
                });
              } catch {
                throw new ServerRoutedInvalidOpenRequestError('Invalid workspace blob-pack open payload');
	              }

	              const sourceRootPath = persistedSourceExport.workspaceSourceRootPath;
	              if (!sourceRootPath) {
	                throw new ServerRoutedAbortTransferError('workspace_replication_source_error');
	              }

	              let payloadSource: TransferPayloadSource;
	              try {
	                payloadSource = await workspaceReplicationAdapter.createBlobPackPayloadSourceFromManifest({
	                  activeServerDir: runtimeConfig.activeServerDir,
	                  packId: workspaceBlobPackTransfer.packId,
	                  digests: openBody.digests,
	                  sourceRootPath,
	                  manifest,
	                });
	              } catch {
	                throw new ServerRoutedAbortTransferError('workspace_replication_source_error');
	              }
		          // Do not cache: the responder owns disposal for blob-pack payload sources, and cache reuse
		          // can cause retries to attempt reusing a disposed file handle/path.
		          return payloadSource;
		        }

        const workspaceManifestTransfer = parseSessionHandoffWorkspaceManifestTransferId(transferId);
        if (workspaceManifestTransfer) {
          const persisted = await waitForPersistedSourceExport(
            workspaceManifestTransfer.handoffId,
            (record) => Boolean(record.workspaceManifest),
            transferTimeoutMsOverride,
          );
          if (persisted?.workspaceManifest) {
            const payloadSource = createFileTransferPayloadSource({
              filePath: persisted.workspaceManifest.filePath,
              sizeBytes: persisted.workspaceManifest.sizeBytes,
              manifestHash: persisted.workspaceManifest.manifestHash,
            });
            ephemeralServerRoutedPayloadSources.set(transferId, payloadSource);
            return payloadSource;
          }
          return null;
        }

	        const agentBundleTransfer = parseSessionHandoffAgentBundleTransferId(transferId);
	        if (agentBundleTransfer) {
          const persisted = await waitForPersistedSourceExport(
            agentBundleTransfer.handoffId,
            (record) => Boolean(record.agentBundle),
            transferTimeoutMsOverride,
          );
          if (persisted?.agentBundle) {
            return createFileTransferPayloadSource({
              filePath: persisted.agentBundle.filePath,
              sizeBytes: persisted.agentBundle.sizeBytes,
              manifestHash: persisted.agentBundle.manifestHash,
            });
          }
          return null;
	        }
	        return null;
	      },
    });
  }

  const startHandler = createSessionHandoffStartActionHandler({
    activeServerDir: runtimeConfig.activeServerDir,
    createUuid,
    loadSessionMetadata,
    machineTransferChannelPresent: params.machineTransferChannel !== undefined,
    directPeerTransfer: params.directPeerTransfer,
    stopSessionForHandoff: params.stopSessionForHandoff,
    prepareJobStore,
    sourceExportStore,
    prepareStartedState,
    exportSessionBundle,
    waitForPersistedSourceExport,
    invalidateDirectPeerRouteCacheForHandoffMachines,
    resolveWorkspaceReplicationHandoffBackTargetRootPath,
    buildStartPendingStatus,
    buildStartRecoveryStatus,
    buildPrepareJobRecord,
    invalidRequest,
    sessionOperationExclusion,
    retainSessionOperationClaim,
    releaseSessionOperationClaim,
  });

  const {
    handle: prepareTargetHandler,
    resumePersistedPrepareTarget,
  } = createSessionHandoffPrepareTargetActionHandler({
    prepareJobStore,
    sourceExportStore,
    activePrepareJobs,
    prepareTargetJobLeaseOwnerId,
    prepareTargetJobLeaseTtlMs,
    runtimeConfig,
    machineTransferChannel: params.machineTransferChannel,
    directPeerTransfer: params.directPeerTransfer,
    workspaceReplicationAdapter,
    workspaceReplicationTransfers,
    importSessionBundle,
    savePreparedTargetLocalMetadata: params.savePreparedTargetLocalMetadata,
    getTransferRouteCache,
    invalidateDirectPeerRouteCacheForHandoffMachines,
  });

  const prepareTargetResumeHandler = createSessionHandoffPrepareTargetResumeActionHandler({
    prepareJobStore,
    resumePersistedPrepareTarget,
  });

  const commitActionHandler = createSessionHandoffCommitActionHandler({
    activeServerDir: runtimeConfig.activeServerDir,
    prepareJobStore,
    sourceExportStore,
    workspaceReplicationAdapter,
    directPeerTransfer: params.directPeerTransfer,
    stopSessionForHandoff: params.stopSessionForHandoff,
    readPersistedPrepareJob,
    buildPrepareJobRecord,
    buildStartPendingStatus,
    buildSourceExportOnlyPrepareJobId,
    invalidateDirectPeerRouteCacheForHandoffMachines,
    disposeEphemeralServerRoutedPayloadSourcesForHandoff,
    invalidRequest,
  });
  const commitHandler = async (raw: unknown): Promise<unknown> => {
    const result = await commitActionHandler(raw);
    const response = result && typeof result === 'object' ? result as Record<string, unknown> : null;
    const status = response?.status && typeof response.status === 'object'
      ? response.status as Record<string, unknown>
      : null;
    if (typeof response?.handoffId === 'string' && status?.status === 'completed') {
      await releaseSessionOperationClaim(response.handoffId);
    }
    return result;
  };

  const abortActionHandler = createSessionHandoffAbortActionHandler({
    activeServerDir: runtimeConfig.activeServerDir,
    prepareJobStore,
    sourceExportStore,
    workspaceReplicationAdapter,
    directPeerTransfer: params.directPeerTransfer,
    readPersistedPrepareJob,
    buildPrepareJobRecord,
    buildStartPendingStatus,
    buildSourceExportOnlyPrepareJobId,
    invalidateDirectPeerRouteCacheForHandoffMachines,
    disposeEphemeralServerRoutedPayloadSourcesForHandoff,
    invalidRequest,
  });
  const abortHandler = async (raw: unknown): Promise<unknown> => {
    const result = await abortActionHandler(raw);
    const response = result && typeof result === 'object' ? result as Record<string, unknown> : null;
    const status = response?.status && typeof response.status === 'object'
      ? response.status as Record<string, unknown>
      : null;
    if (typeof response?.handoffId === 'string' && status?.status === 'aborted') {
      await releaseSessionOperationClaim(response.handoffId);
    }
    return result;
  };

  const statusGetHandler = createSessionHandoffStatusGetActionHandler({
    activeServerDir: runtimeConfig.activeServerDir,
    prepareJobStore,
    sourceExportStore,
    workspaceReplicationAdapter,
    readPersistedPrepareJob,
    buildStartPendingStatus,
    invalidRequest,
  });

  const prepareTargetResultGetHandler = createSessionHandoffPrepareTargetResultGetActionHandler({
    prepareJobStore,
    readPersistedPrepareJob,
    isTerminalHandoffStatus,
    invalidRequest,
  });

  const lifecycleExecutor = createSessionLifecycleRpcActionExecutor({
    'session.handoff': startHandler,
    'session.handoff.prepare_target': prepareTargetHandler,
    'session.handoff.prepare_target.resume': prepareTargetResumeHandler,
    'session.handoff.prepare_target_result.get': prepareTargetResultGetHandler,
    'session.handoff.commit': commitHandler,
    'session.handoff.abort': abortHandler,
    'session.handoff.status.get': statusGetHandler,
  });
  registerSessionLifecycleRpcHandlers({
    rpcHandlerManager,
    actionExecutor: params.coordinateSessionHandoff
      ? {
          execute: async (actionId, input, context) => {
            if (actionId !== 'session.handoff') {
              return await lifecycleExecutor.execute(actionId, input, context);
            }
            return await params.coordinateSessionHandoff!({
              actionInput: input,
              start: async () => await lifecycleExecutor.execute(actionId, input, context),
              signal: context?.signal ?? new AbortController().signal,
              publishOwnerUpdate: (update) => {
                context?.operationOwnerUpdate?.update(update);
              },
            });
          },
        }
      : lifecycleExecutor,
    scopes: SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
    ...(params.observeExecution ? { observeExecution: params.observeExecution } : {}),
  });

  registerSessionHandoffPredecessorCompatibilityHandlers({
    rpcHandlerManager,
    prepareJobStore,
    prepareTarget: prepareTargetHandler,
    prepareTargetResultGet: prepareTargetResultGetHandler,
    commit: commitHandler,
    abort: abortHandler,
    ...(params.spawnSessionForHandoff
      ? { spawnSessionForHandoff: params.spawnSessionForHandoff }
      : {}),
    ...(params.stopSessionForHandoff
      ? { stopSessionForHandoff: params.stopSessionForHandoff }
      : {}),
  });
}
