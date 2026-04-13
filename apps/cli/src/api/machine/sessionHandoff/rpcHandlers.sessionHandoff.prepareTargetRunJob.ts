import os from 'node:os';

import { configuration } from '@/configuration';
import {
  DirectSessionsSourceSchema,
  type AgentRuntimeDescriptorV1,
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffPrepareTargetResultGetResponse,
  type SessionHandoffResumePlan,
  type SessionHandoffStatus,
} from '@happier-dev/protocol';

import type { MachineTransferChannel } from '../../../machines/transfer/serverRoutedTransport';
import { rewriteDirectPeerEndpointCandidatesForTransferId } from '../../../machines/transfer/rewriteDirectPeerEndpointCandidatesForTransferId';
import { createMachineTransferRouteCache } from '../../../machines/transfer/transferRouteCache';
import { readSessionHandoffProviderBundleFile } from '../../../session/handoff/sessionHandoffProviderBundleFile';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import {
  releaseSessionHandoffPrepareTargetJobLease,
  startSessionHandoffPrepareTargetJobLeaseHeartbeat,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobLease';
import type { SessionHandoffProviderBundle } from '../../../session/handoff/types';
import {
  createSessionHandoffWorkspaceReplicationAdapter,
} from '../../../workspace/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter';
import {
  buildSessionHandoffWorkspaceManifestTransferId,
} from '../../../workspace/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationServerRouted';
import { readWorkspaceReplicationManifestFromFile } from '../../../workspace/handoff/workspaceReplicationAdapter/workspaceReplicationManifestFile';

import {
  directPeerTransferUnavailable,
  resolvePrepareProviderBundle,
  resolvePrepareWorkspaceReplicationMetadata,
  type SessionHandoffDirectPeerTransferHandle,
} from './rpcHandlers.sessionHandoff.prepareTransportResolution';
import {
  buildPrepareJobRecord,
  buildPreparePendingStatus,
  buildWorkspaceReplicationStatusProgress,
  missingHandoffMetadataV2,
  normalizeHandoffWorkspaceRootPath,
  resolvePrepareTargetWorkspaceRootPath,
} from './rpcHandlers.sessionHandoff.prepareTargetState';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;
type SessionHandoffWorkspaceReplicationTransfers = ReturnType<SessionHandoffWorkspaceReplicationAdapter['createReplicationTransfers']>;
type SessionHandoffTransportRouteCache = ReturnType<typeof createMachineTransferRouteCache>;

export type RunSessionHandoffPrepareTargetJobInput = Readonly<{
  activeServerDir: string;
  homeDir: string;
  jobId: string;
  handoffId: string;
  createdAtMs: number;
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  pendingStatus: SessionHandoffStatus;
  prepareTargetRequest?: SessionHandoffPrepareTargetRequest;
  workspaceReplicationJobId?: string;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  prepareTargetJobLeaseOwnerId: string;
  prepareTargetJobLeaseTtlMs: number;
  machineTransferChannel: MachineTransferChannel | undefined;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  workspaceReplicationAdapter: SessionHandoffWorkspaceReplicationAdapter;
  workspaceReplicationTransfers: SessionHandoffWorkspaceReplicationTransfers;
  importSessionBundle: (
    bundle: SessionHandoffProviderBundle,
    targetPath: string,
    sessionStorageMode: 'direct' | 'persisted',
  ) => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
    resume: SessionHandoffResumePlan;
  }>>;
  savePreparedTargetLocalMetadata?: (input: Readonly<{
    remoteSessionId: string;
    exportMetadataOverlay: Record<string, unknown>;
  }>) => Promise<void> | void;
  getTransferRouteCache: (
    machineTransferChannel: MachineTransferChannel | undefined,
  ) => SessionHandoffTransportRouteCache;
  invalidateDirectPeerRouteCacheForHandoffMachines: (
    machineIds: readonly (string | undefined)[],
  ) => void;
}>;

export async function runSessionHandoffPrepareTargetJob(
  params: RunSessionHandoffPrepareTargetJobInput,
): Promise<void> {
  const {
    activeServerDir,
    homeDir,
    jobId,
    handoffId,
    createdAtMs,
    request,
    actualTransportStrategy: initialTransportStrategy,
    pendingStatus,
    prepareTargetRequest: initialPrepareTargetRequest,
    workspaceReplicationJobId: initialWorkspaceReplicationJobId,
    prepareJobStore,
    sourceExportStore,
    prepareTargetJobLeaseOwnerId,
    prepareTargetJobLeaseTtlMs,
    machineTransferChannel,
    directPeerTransfer,
    workspaceReplicationAdapter,
    workspaceReplicationTransfers,
    importSessionBundle,
    savePreparedTargetLocalMetadata,
    getTransferRouteCache,
    invalidateDirectPeerRouteCacheForHandoffMachines,
  } = params;

  let leaseAcquired = false;
  let leaseHeartbeat: Readonly<{ stop: () => Promise<void> }> | null = null;
  let workspaceReplicationJobId: string | undefined = initialWorkspaceReplicationJobId;
  let prepareTargetRequest: SessionHandoffPrepareTargetRequest | undefined = initialPrepareTargetRequest ?? request;
  let actualTransportStrategy = initialTransportStrategy;
  let providerBundle: SessionHandoffProviderBundle | null = null;

  const persistJobRecord = async (jobRecord: SessionHandoffPrepareTargetJobRecordInput): Promise<void> => {
    if (jobRecord.workspaceReplicationJobId) {
      workspaceReplicationJobId = workspaceReplicationJobId ?? jobRecord.workspaceReplicationJobId;
    }
    const mergedJobRecord =
      workspaceReplicationJobId && !jobRecord.workspaceReplicationJobId
        ? {
            ...jobRecord,
            workspaceReplicationJobId,
          }
        : jobRecord;
    const mergedWithRequest =
      prepareTargetRequest && !mergedJobRecord.prepareTargetRequest
        ? {
            ...mergedJobRecord,
            prepareTargetRequest,
          }
        : mergedJobRecord;
    if (mergedWithRequest.prepareTargetRequest) {
      prepareTargetRequest = prepareTargetRequest ?? mergedWithRequest.prepareTargetRequest;
    }
    await prepareJobStore.write(mergedWithRequest);
  };

  try {
    const assertPrepareJobNotCancelled = async (): Promise<void> => {
      const latestJob = await prepareJobStore.read(jobId);
      if (latestJob?.cancelRequestedAtMs) {
        throw new Error(`Session handoff prepare aborted: ${handoffId}`);
      }
    };

    const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
      activeServerDir,
      jobId,
      ownerId: prepareTargetJobLeaseOwnerId,
      nowMs: Date.now(),
      ttlMs: prepareTargetJobLeaseTtlMs,
    });
    if (!leaseAttempt.acquired) {
      return;
    }

    leaseAcquired = true;
    leaseHeartbeat = startSessionHandoffPrepareTargetJobLeaseHeartbeat({
      activeServerDir,
      jobId,
      ownerId: prepareTargetJobLeaseOwnerId,
      ttlMs: prepareTargetJobLeaseTtlMs,
      nowMs: () => Date.now(),
    });

    try {
      const wasCancelledBeforeWorkspaceImport = await prepareJobStore.read(jobId);
      if (wasCancelledBeforeWorkspaceImport?.cancelRequestedAtMs) {
        const abortedAtMs = Date.now();
        await persistJobRecord(buildPrepareJobRecord({
          jobId,
          handoffId,
          createdAtMs,
          updatedAtMs: abortedAtMs,
          cancelRequestedAtMs: wasCancelledBeforeWorkspaceImport.cancelRequestedAtMs,
          abortedAtMs,
          status: {
            ...pendingStatus,
            status: 'aborted',
          },
        }));
        return;
      }

      const resolvedWorkspaceTransfer = request.workspaceTransfer;
      actualTransportStrategy = request.negotiatedTransportStrategy;
      const requestResolvedHandoffMetadataV2 = request.handoffMetadataV2;
      const allowServerRoutedFallback = request.allowServerRoutedFallback !== false;
      const canFallbackToServerRouted = allowServerRoutedFallback && machineTransferChannel !== undefined;
      const directPeerRequester = directPeerTransfer?.requestPayloadFile;
      const localSourceExport = await sourceExportStore.load(handoffId);
      const localProviderBundle =
        localSourceExport?.providerBundle
          ? await readSessionHandoffProviderBundleFile(localSourceExport.providerBundle.filePath).catch(() => null)
          : null;
      const localProviderBundleEndpointCandidates = localSourceExport?.providerBundle?.endpointCandidates;
      const localWorkspaceReplicationMetadata =
        localSourceExport?.workspaceManifest && localSourceExport.workspaceSourceRootPath
          ? {
              sourceRootPath: localSourceExport.workspaceSourceRootPath,
              manifest: await readWorkspaceReplicationManifestFromFile({
                transferId: localSourceExport.workspaceManifest.transferId,
                filePath: localSourceExport.workspaceManifest.filePath,
                sizeBytes: localSourceExport.workspaceManifest.sizeBytes,
              }),
            }
          : undefined;
      const localWorkspaceManifestEndpointCandidates = localSourceExport?.workspaceManifest?.endpointCandidates;

      const hasProviderBundleTransferPublication =
        requestResolvedHandoffMetadataV2?.providerBundleTransferPublication !== undefined;
      if (
        actualTransportStrategy === 'direct_peer'
        && !hasProviderBundleTransferPublication
        && !localProviderBundle
      ) {
        if (canFallbackToServerRouted) {
          actualTransportStrategy = 'server_routed_stream';
        } else {
          throw new Error(missingHandoffMetadataV2().error);
        }
      }

      const needsWorkspaceReplicationMetadata = resolvedWorkspaceTransfer?.enabled === true;
      if (needsWorkspaceReplicationMetadata) {
        if (
          !localWorkspaceReplicationMetadata
          && (
            requestResolvedHandoffMetadataV2?.workspaceReplicationSourceRootPath === undefined
            || requestResolvedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication === undefined
          )
        ) {
          throw new Error(missingHandoffMetadataV2().error);
        }
      }

      if (actualTransportStrategy === 'direct_peer') {
        const providerEndpointCandidates =
          requestResolvedHandoffMetadataV2?.providerBundleTransferPublication?.endpointCandidates
          ?? localProviderBundleEndpointCandidates;
        const providerCandidatesFallback = providerEndpointCandidates ?? request.endpointCandidates;
        const manifestEndpointCandidates =
          requestResolvedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates
          ?? localWorkspaceManifestEndpointCandidates
          ?? (request.endpointCandidates.length
            ? rewriteDirectPeerEndpointCandidatesForTransferId({
                endpointCandidates: request.endpointCandidates,
                transferId:
                  requestResolvedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.transferId
                  ?? buildSessionHandoffWorkspaceManifestTransferId({ handoffId }),
              })
            : undefined);

        const nowMs = Date.now();
        const hasUsableProviderEndpointCandidates =
          Array.isArray(providerCandidatesFallback)
          && providerCandidatesFallback.some((candidate) => candidate.expiresAt >= nowMs);
        const hasUsableManifestEndpointCandidates =
          Array.isArray(manifestEndpointCandidates)
          && manifestEndpointCandidates.some((candidate) => candidate.expiresAt >= nowMs);

        const canUseDirectPeerForProviderBundle =
          Boolean(localProviderBundle)
          || (
            (typeof directPeerRequester === 'function' || resolvedWorkspaceTransfer?.enabled === true)
            && hasUsableProviderEndpointCandidates
          );
        const canUseDirectPeerForWorkspaceManifest =
          resolvedWorkspaceTransfer?.enabled !== true
          || !needsWorkspaceReplicationMetadata
          || Boolean(localWorkspaceReplicationMetadata)
          || (
            (typeof directPeerRequester === 'function' || resolvedWorkspaceTransfer?.enabled === true)
            && hasUsableManifestEndpointCandidates
          );

        if (!canUseDirectPeerForProviderBundle || !canUseDirectPeerForWorkspaceManifest) {
          if (canFallbackToServerRouted) {
            actualTransportStrategy = 'server_routed_stream';
          } else {
            throw new Error(directPeerTransferUnavailable().error);
          }
        }
      }

      const resolvedProviderBundle =
        localProviderBundle
        ?? await resolvePrepareProviderBundle({
          request,
          actualTransportStrategy,
          handoffMetadataV2: requestResolvedHandoffMetadataV2,
          machineTransferChannel,
          directPeerTransfer,
          transferRouteCache: getTransferRouteCache(machineTransferChannel),
          invalidateDirectPeerRouteCacheForHandoffMachines,
        });
      if (!resolvedProviderBundle) {
        throw new Error('Invalid session handoff provider bundle');
      }
      providerBundle = resolvedProviderBundle;
      const persistedHandoffMetadataV2 = requestResolvedHandoffMetadataV2;
      const persistedWorkspaceReplicationMetadata =
        localWorkspaceReplicationMetadata
        ?? await resolvePrepareWorkspaceReplicationMetadata({
          request,
          actualTransportStrategy,
          workspaceTransfer: resolvedWorkspaceTransfer,
          handoffMetadataV2: persistedHandoffMetadataV2,
          machineTransferChannel,
          directPeerTransfer,
          invalidateDirectPeerRouteCacheForHandoffMachines,
        });
      const {
        currentTargetManifest,
        sourceOffer,
        importedWorkspace,
      } = await workspaceReplicationAdapter.prepareTargetWorkspace({
        activeServerDir,
        actualTransportStrategy,
        handoffId,
        sourceMachineId: request.sourceMachineId,
        targetMachineId: request.targetMachineId,
        targetPath: resolvePrepareTargetWorkspaceRootPath({
          requestedTargetPath: request.targetPath,
          workspaceTransfer: resolvedWorkspaceTransfer,
          handoffMetadataV2: persistedHandoffMetadataV2,
          homeDir,
        }),
        workspaceTransfer: resolvedWorkspaceTransfer,
        metadata: persistedWorkspaceReplicationMetadata,
        directPeerManifestEndpointCandidates:
          persistedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates
          ?? localWorkspaceManifestEndpointCandidates,
        machineTransferChannel,
        allowServerRoutedFallback: canFallbackToServerRouted,
        transfers: workspaceReplicationTransfers,
        blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
        blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
        blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
        serverRoutedTransferTimeoutMs:
          typeof configuration.filesTransferSessionTtlMs === 'number' && configuration.filesTransferSessionTtlMs > 0
            ? configuration.filesTransferSessionTtlMs
            : undefined,
        onWorkspaceReplicationJobStarted: async (startedWorkspaceReplicationJobId: string) => {
          workspaceReplicationJobId = workspaceReplicationJobId ?? startedWorkspaceReplicationJobId;
          await prepareJobStore.update(jobId, (currentRecord) => {
            const { schemaVersion: _schemaVersion, ...rest } = currentRecord;
            return {
              ...rest,
              workspaceReplicationJobId: rest.workspaceReplicationJobId ?? startedWorkspaceReplicationJobId,
              updatedAtMs: Date.now(),
            };
          });
        },
        assertCanContinue: assertPrepareJobNotCancelled,
      });
      const workspaceStatusProgress =
        resolvedWorkspaceTransfer?.enabled && sourceOffer
          ? buildWorkspaceReplicationStatusProgress({
              previousManifest: currentTargetManifest,
              nextManifest: sourceOffer.manifest,
              blobCount: sourceOffer.blobIndex.length,
              checkpoint: 'import_session',
              phaseDetail: 'importing_session',
            })
          : null;
      await persistJobRecord(buildPrepareJobRecord({
        jobId,
        handoffId,
        createdAtMs,
        updatedAtMs: Date.now(),
        status: {
          ...buildPreparePendingStatus({
            handoffId,
            jobId,
            transportStrategy: actualTransportStrategy,
            recoveryActions: pendingStatus.recoveryActions,
            phaseDetail: 'importing_session',
          }),
          ...(workspaceStatusProgress ?? {}),
        },
      }));

      const afterWorkspaceImportJob = await prepareJobStore.read(jobId);
      if (afterWorkspaceImportJob?.cancelRequestedAtMs) {
        const abortedAtMs = Date.now();
        await persistJobRecord(buildPrepareJobRecord({
          jobId,
          handoffId,
          createdAtMs,
          updatedAtMs: abortedAtMs,
          cancelRequestedAtMs: afterWorkspaceImportJob.cancelRequestedAtMs,
          abortedAtMs,
          status: {
            ...afterWorkspaceImportJob.status,
            status: 'aborted',
          },
        }));
        return;
      }

      const imported = await importSessionBundle(
        providerBundle,
        importedWorkspace.targetPath,
        request.targetSessionStorageMode === 'persisted'
          ? 'persisted'
          : request.sourceSessionStorageMode === 'persisted'
            ? 'persisted'
            : 'direct',
      );
      const directSource = DirectSessionsSourceSchema.parse(imported.directSource);
      const readyForCutoverStatusBase: SessionHandoffStatus = {
        ...pendingStatus,
        status: 'ready_for_cutover',
        phase: 'staging_target',
        transportStrategy: actualTransportStrategy,
      };
      const readyForCutoverStatus: SessionHandoffStatus = workspaceStatusProgress
        ? {
            ...readyForCutoverStatusBase,
            ...buildWorkspaceReplicationStatusProgress({
              previousManifest: currentTargetManifest,
              nextManifest: sourceOffer!.manifest,
              blobCount: sourceOffer!.blobIndex.length,
              checkpoint: 'import_session',
              phaseDetail: 'ready_for_cutover',
            }),
          }
        : {
            ...readyForCutoverStatusBase,
            progress: {
              updatedAtMs: Date.now(),
              checkpoint: 'import_session',
              planned: {},
              transferred: {},
              current: {
                phaseDetail: 'ready_for_cutover',
              },
              resumable: false,
            },
          };
      const prepareResult: SessionHandoffPrepareTargetResultGetResponse = {
        handoffId,
        status: readyForCutoverStatus,
        remoteSessionId: imported.remoteSessionId,
        directSource,
        ...(imported.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: imported.agentRuntimeDescriptorV1 } : {}),
        resume: imported.resume,
      };
      const handoffBackTargetRootPath =
        normalizeHandoffWorkspaceRootPath(
          request.handoffMetadataV2?.workspaceReplicationHandoffBackTargetRootPath,
        )
        ?? normalizeHandoffWorkspaceRootPath(
          request.handoffMetadataV2?.workspaceReplicationSourceRootPath,
        );
      const importedTargetWorkspaceRootPath = normalizeHandoffWorkspaceRootPath(imported.resume.directory);
      if (
        savePreparedTargetLocalMetadata
        && handoffBackTargetRootPath
        && importedTargetWorkspaceRootPath
      ) {
        await savePreparedTargetLocalMetadata({
          remoteSessionId: imported.remoteSessionId,
          exportMetadataOverlay: {
            handoffV1: {
              v: 1,
              sourceMachineId: request.sourceMachineId,
              targetMachineId: request.targetMachineId,
              providerId: imported.resume.agent,
              sessionStorageBefore: request.sourceSessionStorageMode,
              sessionStorageAfter: imported.resume.transcriptStorage,
              transportStrategy: actualTransportStrategy,
              completedAtMs: Date.now(),
              sourceWorkspaceRootPath: handoffBackTargetRootPath,
              targetWorkspaceRootPath: importedTargetWorkspaceRootPath,
            },
          },
        });
      }
      const afterImportJob = await prepareJobStore.read(jobId);
      if (afterImportJob?.cancelRequestedAtMs) {
        const abortedAtMs = Date.now();
        await persistJobRecord(buildPrepareJobRecord({
          jobId,
          handoffId,
          createdAtMs,
          updatedAtMs: abortedAtMs,
          cancelRequestedAtMs: afterImportJob.cancelRequestedAtMs,
          abortedAtMs,
          status: {
            ...readyForCutoverStatus,
            status: 'aborted',
          },
        }));
        return;
      }
      await persistJobRecord(buildPrepareJobRecord({
        jobId,
        handoffId,
        createdAtMs,
        updatedAtMs: Date.now(),
        completedAtMs: Date.now(),
        status: readyForCutoverStatus,
        prepareTargetResult: prepareResult,
      }));
    } catch (error) {
      const failedAtMs = Date.now();
      const currentJob = await prepareJobStore.read(jobId);
      const failedStatus: SessionHandoffStatus = {
        ...(currentJob?.status ?? pendingStatus),
        status: currentJob?.cancelRequestedAtMs ? 'aborted' : 'awaiting_recovery',
      };
      await persistJobRecord(buildPrepareJobRecord({
        jobId,
        handoffId,
        createdAtMs,
        updatedAtMs: failedAtMs,
        ...(currentJob?.cancelRequestedAtMs ? { cancelRequestedAtMs: currentJob.cancelRequestedAtMs, abortedAtMs: failedAtMs } : { failedAtMs }),
        lastErrorMessage: error instanceof Error ? error.message : 'Failed to prepare handoff target',
        status: failedStatus,
      }));
    }
  } finally {
    await leaseHeartbeat?.stop().catch(() => undefined);
    if (leaseAcquired) {
      await releaseSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId: prepareTargetJobLeaseOwnerId,
      }).catch(() => undefined);
    }
  }
}
