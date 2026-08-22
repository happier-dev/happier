import os from 'node:os';

import {
  ExternalSessionsSourceSchema,
  type RuntimeDescriptorV1,
  type SessionHandoffPrepareTargetFailure,
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffPrepareTargetResultGetSuccessResponse,
  type SessionHandoffResumePlan,
  type SessionHandoffStatus,
} from '@happier-dev/protocol';

import type { MachineTransferChannel } from '../../../machines/transfer/serverRoutedTransport';
import { rewriteDirectPeerEndpointCandidatesForTransferId } from '../../../machines/transfer/rewriteDirectPeerEndpointCandidatesForTransferId';
import { createMachineTransferRouteCache } from '../../../machines/transfer/transferRouteCache';
import { readSessionHandoffAgentBundleFile } from '../../../session/handoff/agentBundle/file';
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
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import { buildSessionHandoffMetadataV1 } from '../../../session/handoff/metadata/sessionHandoffMetadataV1';
import {
  createSessionHandoffWorkspaceReplicationAdapter,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';
import {
  buildSessionHandoffWorkspaceManifestTransferId,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';
import { readWorkspaceReplicationManifestFromFile } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/manifestFile';

import {
  directPeerTransferUnavailable,
  resolvePrepareAgentBundle,
  resolvePrepareWorkspaceReplicationMetadata,
  type SessionHandoffDirectPeerTransferHandle,
} from './prepareTransport';
import {
  buildPrepareJobRecord,
  buildPreparePendingStatus,
  buildWorkspaceReplicationStatusProgress,
  missingHandoffMetadataV2,
  normalizeHandoffWorkspaceRootPath,
  resolvePrepareTargetWorkspaceRootPath,
} from './prepareTargetState';
import {
  resolveSessionHandoffTransferTimeoutMs,
  type SessionHandoffRuntimeConfig,
} from './runtimeConfig';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;
type SessionHandoffWorkspaceReplicationTransfers = ReturnType<SessionHandoffWorkspaceReplicationAdapter['createReplicationTransfers']>;
type SessionHandoffTransportRouteCache = ReturnType<typeof createMachineTransferRouteCache>;

export type RunSessionHandoffPrepareTargetJobInput = Readonly<{
  activeServerDir: string;
  homeDir: string;
  runtimeConfig: SessionHandoffRuntimeConfig;
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
    bundle: SessionHandoffAgentBundle,
    targetPath: string,
    sessionStorageMode: 'direct' | 'persisted',
  ) => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
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

function resolveTypedImportFailure(error: unknown): SessionHandoffPrepareTargetFailure | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as Readonly<{ code?: unknown }>).code;
  return code === 'target_identity_conflict' || code === 'agent_version_unsupported'
    ? { code }
    : null;
}

function resolveTypedImportFailureMessage(
  failure: SessionHandoffPrepareTargetFailure,
): string {
  return failure.code === 'target_identity_conflict'
    ? 'The native handoff target conflicts with the exported session identity'
    : 'The installed Agent version cannot safely import this handoff';
}

function resolvePrepareTargetFailureCode(message: string): string | undefined {
  if (message === directPeerTransferUnavailable().error) {
    return directPeerTransferUnavailable().errorCode;
  }
  if (message === missingHandoffMetadataV2().error) {
    return missingHandoffMetadataV2().errorCode;
  }
  return undefined;
}

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
  const transferTimeoutMs = resolveSessionHandoffTransferTimeoutMs(params.runtimeConfig);

  let leaseAcquired = false;
  let leaseHeartbeat: Readonly<{ stop: () => Promise<void> }> | null = null;
  let workspaceReplicationJobId: string | undefined = initialWorkspaceReplicationJobId;
  let prepareTargetRequest: SessionHandoffPrepareTargetRequest | undefined = initialPrepareTargetRequest ?? request;
  let actualTransportStrategy = initialTransportStrategy;
  let agentBundle: SessionHandoffAgentBundle | null = null;

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
      const localAgentBundle =
        localSourceExport?.agentBundle
          ? await readSessionHandoffAgentBundleFile(localSourceExport.agentBundle.filePath).catch(() => null)
          : null;
      const localAgentBundleEndpointCandidates = localSourceExport?.agentBundle?.endpointCandidates;
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

      const hasAgentBundleTransferPublication =
        requestResolvedHandoffMetadataV2?.agentBundleTransferPublication !== undefined;
      if (
        actualTransportStrategy === 'direct_peer'
        && !hasAgentBundleTransferPublication
        && !localAgentBundle
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
          requestResolvedHandoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates
          ?? localAgentBundleEndpointCandidates;
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

        const canUseDirectPeerForAgentBundle =
          Boolean(localAgentBundle)
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

        if (!canUseDirectPeerForAgentBundle || !canUseDirectPeerForWorkspaceManifest) {
          if (canFallbackToServerRouted) {
            actualTransportStrategy = 'server_routed_stream';
          } else {
            throw new Error(directPeerTransferUnavailable().error);
          }
        }
      }

      const resolvedAgentBundle =
        localAgentBundle
        ?? await resolvePrepareAgentBundle({
          request,
          actualTransportStrategy,
          handoffMetadataV2: requestResolvedHandoffMetadataV2,
          machineTransferChannel,
          directPeerTransfer,
          transferRouteCache: getTransferRouteCache(machineTransferChannel),
          transferTimeoutMs,
          invalidateDirectPeerRouteCacheForHandoffMachines,
        });
      if (!resolvedAgentBundle) {
        throw new Error('Invalid session handoff provider bundle');
      }
      agentBundle = resolvedAgentBundle;
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
          transferTimeoutMs,
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
        blobPackTargetBytes: params.runtimeConfig.workspaceReplicationBlobPackTargetBytes,
        blobPackMaxBlobs: params.runtimeConfig.workspaceReplicationBlobPackMaxBlobs,
        blobPackMaxSingleBlobBytes: params.runtimeConfig.workspaceReplicationBlobPackMaxSingleBlobBytes,
        serverRoutedTransferTimeoutMs:
          typeof params.runtimeConfig.filesTransferSessionTtlMs === 'number'
            && params.runtimeConfig.filesTransferSessionTtlMs > 0
            ? params.runtimeConfig.filesTransferSessionTtlMs
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
        agentBundle,
        importedWorkspace.targetPath,
        request.targetSessionStorageMode === 'persisted'
          ? 'persisted'
          : request.sourceSessionStorageMode === 'persisted'
            ? 'persisted'
            : 'direct',
      );
      const directSource = ExternalSessionsSourceSchema.parse(imported.directSource);
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
      const prepareResult: SessionHandoffPrepareTargetResultGetSuccessResponse = {
        handoffId,
        status: readyForCutoverStatus,
        remoteSessionId: imported.remoteSessionId,
        directSource,
        ...(imported.runtimeDescriptorV1 ? { runtimeDescriptorV1: imported.runtimeDescriptorV1 } : {}),
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
            handoffV1: buildSessionHandoffMetadataV1({
              sourceMachineId: request.sourceMachineId,
              targetMachineId: request.targetMachineId,
              agentId: imported.resume.agent,
              sessionStorageBefore: request.sourceSessionStorageMode,
              sessionStorageAfter: imported.resume.transcriptStorage,
              transportStrategy: actualTransportStrategy,
              completedAtMs: Date.now(),
              sourceWorkspaceRootPath: handoffBackTargetRootPath,
              targetWorkspaceRootPath: importedTargetWorkspaceRootPath,
            }),
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
      const typedImportFailure = resolveTypedImportFailure(error);
      const lastErrorMessage = typedImportFailure
        ? resolveTypedImportFailureMessage(typedImportFailure)
        : error instanceof Error
          ? error.message
          : 'Failed to prepare handoff target';
      const lastErrorCode = resolvePrepareTargetFailureCode(lastErrorMessage);
      const { failure: _previousFailure, ...currentStatusWithoutFailure } =
        currentJob?.status ?? pendingStatus;
      const failedStatus: SessionHandoffStatus = {
        ...currentStatusWithoutFailure,
        status: currentJob?.cancelRequestedAtMs
          ? 'aborted'
          : typedImportFailure?.code === 'target_identity_conflict'
            ? 'reconciliation_required'
            : typedImportFailure?.code === 'agent_version_unsupported'
              ? 'failed'
              : 'awaiting_recovery',
        ...(typedImportFailure && !currentJob?.cancelRequestedAtMs
          ? {
              failure: typedImportFailure,
              recoveryActions: [],
            }
          : {}),
      };
      await persistJobRecord(buildPrepareJobRecord({
        jobId,
        handoffId,
        createdAtMs,
        updatedAtMs: failedAtMs,
        ...(currentJob?.cancelRequestedAtMs ? { cancelRequestedAtMs: currentJob.cancelRequestedAtMs, abortedAtMs: failedAtMs } : { failedAtMs }),
        ...(lastErrorCode ? { lastErrorCode } : {}),
        lastErrorMessage,
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
