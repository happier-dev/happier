import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import {
  DirectSessionsSourceSchema,
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
import { importSessionHandoffProviderBundle } from '../../../session/handoff/providerBundle/import';
import {
  resolveSessionHandoffExportMetadata,
  type SessionHandoffLocalMetadataSource,
} from '../../../session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import {
  readSessionHandoffProviderBundleFile,
} from '../../../session/handoff/providerBundle/file';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  parseSessionHandoffProviderBundleTransferId,
  type SessionHandoffProviderBundleTransferPublication
} from '../../../session/handoff/providerBundle/transferPublication';
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
  type SessionHandoffPrepareTargetJobRecord,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import {
  releaseSessionHandoffPrepareTargetJobLease,
  resolveSessionHandoffPrepareTargetJobLeaseTtlMs,
  startSessionHandoffPrepareTargetJobLeaseHeartbeat,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobLease';

import type { RpcHandlerManager } from '../../rpc/RpcHandlerManager';
import {
  createSessionLifecycleRpcActionExecutor,
  registerSessionLifecycleRpcHandlers,
  SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
} from '@/rpc/handlers/sessionLifecycle';
import type { SessionHandoffProviderBundle } from '../../../session/handoff/types';
import {
  directPeerTransferUnavailable,
  isSessionHandoffDirectPeerProtocolError,
  resolvePrepareProviderBundle,
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

export type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';

// Status polling can race against the background prepare runner acquiring its durable lease and
// writing the runner heartbeat marker. Avoid incorrectly flipping a freshly (re)started job into
// `awaiting_recovery` in that window.
const PREPARE_TARGET_JOB_RECOVERY_GRACE_MAX_MS = 2_000;

type SessionHandoffExportBundleResult = Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  targetPath: string;
}>;

function isMachineTransferTimeoutErrorMessage(message: string): boolean {
  return message.startsWith('Timed out waiting for machine transfer ');
}

export function registerMachineSessionHandoffRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  loadSessionMetadata?: (sessionId: string) => Promise<Record<string, unknown> | null>;
  savePreparedTargetLocalMetadata?: (input: Readonly<{
    remoteSessionId: string;
    exportMetadataOverlay: Record<string, unknown>;
  }>) => Promise<void> | void;
  stopSessionForHandoff?: (sessionId: string) => Promise<'stopped' | 'already_inactive' | 'failed'>;
  exportSessionBundle?: (metadata: Record<string, unknown>) => Promise<Readonly<{
    providerBundle: SessionHandoffProviderBundle;
    targetPath: string;
  }>>;
  importSessionBundle?: (bundle: SessionHandoffProviderBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    resume: SessionHandoffResumePlan;
  }>>;
  machineTransferChannel?: MachineTransferChannel;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
}>): void {
  const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
    activeServerDir: configuration.activeServerDir,
  });
  const sourceExportStore = createSessionHandoffSourceExportStore({
    activeServerDir: configuration.activeServerDir,
  });
  const activePrepareJobs = new Map<string, Promise<void>>();
  // Used to restart prepare-target durable jobs when only status/result polling continues after a daemon restart.
  let restartPrepareTargetJobFromPersistedRequest: ((raw: unknown) => Promise<unknown>) | null = null;
  const prepareTargetJobLeaseOwnerId = `cli-daemon:${process.pid}:${randomUUID()}`;
  const prepareTargetJobLeaseTtlMs = resolveSessionHandoffPrepareTargetJobLeaseTtlMs();
  const prepareTargetJobRecoveryGraceMs = Math.min(
    PREPARE_TARGET_JOB_RECOVERY_GRACE_MAX_MS,
    Math.max(250, Math.floor(prepareTargetJobLeaseTtlMs / 4)),
  );
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
        serverId: `unknown:${process.pid}:${randomUUID()}`,
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
  const workspaceReplicationAdapter = createSessionHandoffWorkspaceReplicationAdapter();
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

  const maybeRecoverPrepareTargetJobMissingRunner = async (
    job: SessionHandoffPrepareTargetJobRecord,
  ): Promise<SessionHandoffPrepareTargetJobRecord> => {
    if (
      job.status.phase !== 'staging_target'
      || (job.status.status !== 'pending' && job.status.status !== 'in_progress')
    ) {
      return job;
    }
    // If this daemon has an active in-memory runner, trust it and avoid any lease probing.
    if (activePrepareJobs.has(job.jobId)) {
      return job;
    }

    const nowMs = Date.now();
    if (job.updatedAtMs + prepareTargetJobRecoveryGraceMs > nowMs) {
      // Give the prepare runner time to acquire/renew its durable lease after a (re)start.
      return job;
    }
    const probeOwnerId = `status-probe:${process.pid}:${randomUUID()}`;
    const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
      activeServerDir: configuration.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
      nowMs,
      // Keep probe leases short so a crashed probe can't stall a real resume attempt.
      ttlMs: 5_000,
    });

    if (!leaseAttempt.acquired) {
      // Another daemon instance appears to hold the lease; keep the durable pending status.
      return job;
    }

    await releaseSessionHandoffPrepareTargetJobLease({
      activeServerDir: configuration.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
    }).catch(() => undefined);

    if (job.cancelRequestedAtMs) {
      // Preserve existing fail-closed behavior: if cancellation was requested and no runner/lease owner exists,
      // mark the job aborted immediately instead of attempting a restart.
    } else if (job.prepareTargetRequest && restartPrepareTargetJobFromPersistedRequest !== null) {
      // Restart in the background. Callers can keep polling status/result without issuing a second PREPARE_TARGET call.
      const restart = restartPrepareTargetJobFromPersistedRequest;
      void restart(job.prepareTargetRequest).catch(() => undefined);
      return job;
    }

    // With no active lease owner, the daemon cannot make forward progress without either:
    // 1) a persisted prepareTargetRequest (so we can restart), or
    // 2) a new PREPARE_TARGET call (so we can rehydrate the request inputs).
    // Fail closed into recovery instead of reporting a status with no runner.
    const recovered = await prepareJobStore.update(job.jobId, (current) => {
      const { schemaVersion: _schemaVersion, ...rest } = current;
      const previousProgress = rest.status.progress;
      const nextProgress = previousProgress
        ? {
          ...previousProgress,
          updatedAtMs: nowMs,
          current: {
            ...(previousProgress.current ?? {}),
            phaseDetail: 'daemon_restart_missing_runner',
          },
        }
        : previousProgress;

      const recoveryMessage = 'Daemon restarted while the handoff prepare-target job was in progress';

      if (rest.cancelRequestedAtMs) {
        return {
          ...rest,
          updatedAtMs: nowMs,
          abortedAtMs: rest.abortedAtMs ?? nowMs,
          status: {
            ...rest.status,
            status: 'aborted',
            ...(nextProgress ? { progress: nextProgress } : {}),
          },
          lastErrorMessage: rest.lastErrorMessage ?? recoveryMessage,
        };
      }

      return {
        ...rest,
        updatedAtMs: nowMs,
        failedAtMs: rest.failedAtMs ?? nowMs,
        status: {
          ...rest.status,
          status: 'awaiting_recovery',
          ...(nextProgress ? { progress: nextProgress } : {}),
        },
        lastErrorMessage: rest.lastErrorMessage ?? recoveryMessage,
      };
    });

    return recovered ?? job;
  };

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
      const [{ readCredentials }, { fetchSessionById }, { tryDecryptSessionMetadata }] = await Promise.all([
        import('../../../persistence'),
        import('@/session/transport/http/sessionsHttp'),
        import('@/session/transport/encryption/sessionEncryptionContext'),
      ]);
      const credentials = await readCredentials().catch(() => null);
      if (!credentials) return null;
      const rawSession = await fetchSessionById({ token: credentials.token, sessionId }).catch(() => null);
      if (!rawSession) return null;
      const metadata = tryDecryptSessionMetadata({ credentials, rawSession });
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
      return await exportSessionHandoffState({
        metadata,
        activeServerDir: configuration.activeServerDir,
      });
    });
  const importSessionBundle =
    params.importSessionBundle ??
    (async (bundle: SessionHandoffProviderBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') =>
      await importSessionHandoffProviderBundle({
        bundle,
        targetPath,
        sessionStorageMode,
      }));
  const prepareStartedState = async (
    callInput: PrepareStartedStateCallInput,
  ) => {
    return await prepareStartedStateCore({
      callInput,
      activeServerDir: configuration.activeServerDir,
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
	              maxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
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
                  blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
                  blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
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
	                  activeServerDir: configuration.activeServerDir,
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

	        const providerBundleTransfer = parseSessionHandoffProviderBundleTransferId(transferId);
	        if (providerBundleTransfer) {
          const persisted = await waitForPersistedSourceExport(
            providerBundleTransfer.handoffId,
            (record) => Boolean(record.providerBundle),
            transferTimeoutMsOverride,
          );
          if (persisted?.providerBundle) {
            return createFileTransferPayloadSource({
              filePath: persisted.providerBundle.filePath,
              sizeBytes: persisted.providerBundle.sizeBytes,
              manifestHash: persisted.providerBundle.manifestHash,
            });
          }
          return null;
	        }
	        return null;
	      },
    });
  }

  const startHandler = createSessionHandoffStartActionHandler({
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
  });

  const {
    handle: prepareTargetHandler,
    restartPrepareTargetJobFromPersistedRequest: restartPrepareTargetJobFromPersistedRequestHandler,
  } = createSessionHandoffPrepareTargetActionHandler({
    prepareJobStore,
    sourceExportStore,
    activePrepareJobs,
    prepareTargetJobLeaseOwnerId,
    prepareTargetJobLeaseTtlMs,
    machineTransferChannel: params.machineTransferChannel,
    directPeerTransfer: params.directPeerTransfer,
    workspaceReplicationAdapter,
    workspaceReplicationTransfers,
    importSessionBundle,
    savePreparedTargetLocalMetadata: params.savePreparedTargetLocalMetadata,
    getTransferRouteCache,
    invalidateDirectPeerRouteCacheForHandoffMachines,
  });

  restartPrepareTargetJobFromPersistedRequest = restartPrepareTargetJobFromPersistedRequestHandler;

  const commitHandler = createSessionHandoffCommitActionHandler({
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

  const abortHandler = createSessionHandoffAbortActionHandler({
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

  const statusGetHandler = createSessionHandoffStatusGetActionHandler({
    prepareJobStore,
    sourceExportStore,
    workspaceReplicationAdapter,
    readPersistedPrepareJob,
    maybeRecoverPrepareTargetJobMissingRunner,
    buildStartPendingStatus,
    invalidRequest,
  });

  const prepareTargetResultGetHandler = createSessionHandoffPrepareTargetResultGetActionHandler({
    prepareJobStore,
    readPersistedPrepareJob,
    maybeRecoverPrepareTargetJobMissingRunner,
    isTerminalHandoffStatus,
    invalidRequest,
  });

  registerSessionLifecycleRpcHandlers({
    rpcHandlerManager,
    actionExecutor: createSessionLifecycleRpcActionExecutor({
      'session.handoff': startHandler,
      'session.handoff.prepare_target': prepareTargetHandler,
      'session.handoff.prepare_target_result.get': prepareTargetResultGetHandler,
      'session.handoff.commit': commitHandler,
      'session.handoff.abort': abortHandler,
      'session.handoff.status.get': statusGetHandler,
    }),
    scopes: SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
  });
}
