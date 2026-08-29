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

import {
  directPeerTransferUnavailable,
  resolvePrepareAgentBundle,
  type SessionHandoffDirectPeerTransferHandle,
} from './prepareTransport';
import {
  buildPrepareJobRecord,
  buildPreparePendingStatus,
  missingHandoffMetadataV2,
} from './prepareTargetState';
import {
  resolveSessionHandoffTransferTimeoutMs,
  type SessionHandoffRuntimeConfig,
} from './runtimeConfig';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SessionHandoffTransportRouteCache = ReturnType<typeof createMachineTransferRouteCache>;

export type RunSessionHandoffPrepareTargetJobInput = Readonly<{
  activeServerDir: string;
  runtimeConfig: SessionHandoffRuntimeConfig;
  jobId: string;
  handoffId: string;
  createdAtMs: number;
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  pendingStatus: SessionHandoffStatus;
  prepareTargetRequest?: SessionHandoffPrepareTargetRequest;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  prepareTargetJobLeaseOwnerId: string;
  prepareTargetJobLeaseTtlMs: number;
  machineTransferChannel: MachineTransferChannel | undefined;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
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
    jobId,
    handoffId,
    createdAtMs,
    request,
    actualTransportStrategy: initialTransportStrategy,
    pendingStatus,
    prepareTargetRequest: initialPrepareTargetRequest,
    prepareJobStore,
    sourceExportStore,
    prepareTargetJobLeaseOwnerId,
    prepareTargetJobLeaseTtlMs,
    machineTransferChannel,
    directPeerTransfer,
    importSessionBundle,
    getTransferRouteCache,
    invalidateDirectPeerRouteCacheForHandoffMachines,
  } = params;
  const transferTimeoutMs = resolveSessionHandoffTransferTimeoutMs(params.runtimeConfig);

  let leaseAcquired = false;
  let leaseHeartbeat: Readonly<{ stop: () => Promise<void> }> | null = null;
  let prepareTargetRequest: SessionHandoffPrepareTargetRequest | undefined = initialPrepareTargetRequest ?? request;
  let actualTransportStrategy = initialTransportStrategy;
  let agentBundle: SessionHandoffAgentBundle | null = null;

  const persistJobRecord = async (jobRecord: SessionHandoffPrepareTargetJobRecordInput): Promise<void> => {
    const mergedWithRequest =
      prepareTargetRequest && !jobRecord.prepareTargetRequest
        ? {
            ...jobRecord,
            prepareTargetRequest,
          }
        : jobRecord;
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
      const wasCancelledBeforeImport = await prepareJobStore.read(jobId);
      if (wasCancelledBeforeImport?.cancelRequestedAtMs) {
        const abortedAtMs = Date.now();
        await persistJobRecord(buildPrepareJobRecord({
          jobId,
          handoffId,
          createdAtMs,
          updatedAtMs: abortedAtMs,
          cancelRequestedAtMs: wasCancelledBeforeImport.cancelRequestedAtMs,
          abortedAtMs,
          status: {
            ...pendingStatus,
            status: 'aborted',
          },
        }));
        return;
      }

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

      if (actualTransportStrategy === 'direct_peer') {
        const providerEndpointCandidates =
          requestResolvedHandoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates
          ?? localAgentBundleEndpointCandidates;
        const providerCandidatesFallback = providerEndpointCandidates ?? request.endpointCandidates;
        const nowMs = Date.now();
        const hasUsableProviderEndpointCandidates =
          Array.isArray(providerCandidatesFallback)
          && providerCandidatesFallback.some((candidate) => candidate.expiresAt >= nowMs);
        const canUseDirectPeerForAgentBundle =
          Boolean(localAgentBundle)
          || (
            typeof directPeerRequester === 'function'
            && hasUsableProviderEndpointCandidates
          );
        if (!canUseDirectPeerForAgentBundle) {
          if (canFallbackToServerRouted) {
            actualTransportStrategy = 'server_routed_stream';
          } else {
            throw new Error(directPeerTransferUnavailable().error);
          }
        }
      }

      const agentBundlePublicationForProgress = requestResolvedHandoffMetadataV2?.agentBundleTransferPublication;
      let lastAgentBundleProgressPersistedAtMs = 0;
      const reportAgentBundleTransferProgress = agentBundlePublicationForProgress
        ? async (receivedBytes: number): Promise<void> => {
          const totalBytes = agentBundlePublicationForProgress.sizeBytes;
          const nowMs = Date.now();
          if (receivedBytes < totalBytes && nowMs - lastAgentBundleProgressPersistedAtMs < 250) {
            return;
          }
          lastAgentBundleProgressPersistedAtMs = nowMs;
          await persistJobRecord(buildPrepareJobRecord({
            jobId,
            handoffId,
            createdAtMs,
            updatedAtMs: nowMs,
            status: buildPreparePendingStatus({
              handoffId,
              jobId,
              transportStrategy: actualTransportStrategy,
              recoveryActions: pendingStatus.recoveryActions,
              phaseDetail: receivedBytes < totalBytes ? 'transferring_session' : 'importing_session',
              sessionTransfer: {
                currentBytes: Math.min(receivedBytes, totalBytes),
                totalBytes,
              },
            }),
          }));
        }
        : undefined;
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
          receivedAgentBundlePath: await sourceExportStore.prepareReceivedAgentBundleFilePath(handoffId),
          ...(reportAgentBundleTransferProgress ? { onProgress: reportAgentBundleTransferProgress } : {}),
        });
      if (!resolvedAgentBundle) {
        throw new Error('Invalid session handoff provider bundle');
      }
      agentBundle = resolvedAgentBundle;
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
        },
      }));

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
            ...afterImportJob.status,
            status: 'aborted',
          },
        }));
        return;
      }

      const imported = await importSessionBundle(
        agentBundle,
        request.targetPath,
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
      const readyForCutoverStatus: SessionHandoffStatus = {
        ...readyForCutoverStatusBase,
        progress: {
          updatedAtMs: Date.now(),
          checkpoint: 'import_session',
          planned: {},
          transferred: {},
          current: { phaseDetail: 'ready_for_cutover' },
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
      const afterImportCompletionJob = await prepareJobStore.read(jobId);
      if (afterImportCompletionJob?.cancelRequestedAtMs) {
        const abortedAtMs = Date.now();
        await persistJobRecord(buildPrepareJobRecord({
          jobId,
          handoffId,
          createdAtMs,
          updatedAtMs: abortedAtMs,
          cancelRequestedAtMs: afterImportCompletionJob.cancelRequestedAtMs,
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
