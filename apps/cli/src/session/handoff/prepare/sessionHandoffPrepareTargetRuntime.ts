import { randomUUID } from 'node:crypto';
import os from 'node:os';

import {
    DirectSessionsSourceSchema,
    type SessionHandoffMetadataV2,
    type SessionHandoffPrepareTargetRequest,
    type SessionHandoffPrepareTargetResultGetResponse,
    type SessionHandoffResumePlan,
    type SessionHandoffStatus,
    type SessionHandoffWorkspaceTransfer,
    type WorkspaceManifest,
} from '@happier-dev/protocol';

import type { MachineTransferChannel } from '../../../machines/transfer/serverRoutedTransport';
import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import type { AgentRuntimeDescriptorV1 } from '@happier-dev/protocol';
import { compareWorkspaceManifests } from '../../../scm/sourceController/workspaceExportPackaging/compareWorkspaceManifests';
import type { SessionHandoffProviderBundle } from '../types';
import { readSessionHandoffProviderBundleFile } from '../sessionHandoffProviderBundleFile';
import {
    normalizeSessionHandoffTargetPathForLocalMachine,
    resolveSessionHandoffLocalHomeDir,
} from '../paths/sessionHandoffPathNormalization';
import {
    createSessionHandoffPrepareTargetJobStore,
    type SessionHandoffPrepareTargetJobRecord,
    type SessionHandoffPrepareTargetJobRecordInput,
} from './sessionHandoffPrepareTargetJobStore';
import {
    releaseSessionHandoffPrepareTargetJobLease,
    resolveSessionHandoffPrepareTargetJobLeaseTtlMs,
    startSessionHandoffPrepareTargetJobLeaseHeartbeat,
    tryAcquireSessionHandoffPrepareTargetJobLease,
} from './sessionHandoffPrepareTargetJobLease';
import type { createSessionHandoffSourceExportStore } from '../state/sessionHandoffSourceExportStore';
import type {
    createSessionHandoffWorkspaceReplicationAdapter,
    SessionHandoffWorkspaceReplicationMetadata,
} from '../workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter';
import { readWorkspaceReplicationManifestFromFile } from '../workspaceReplicationAdapter/workspaceReplicationManifestFile';

const PREPARE_JOB_FAST_PATH_BUDGET_MS = 250;
const PREPARE_TARGET_JOB_RECOVERY_GRACE_MAX_MS = 2_000;

type WorkspaceReplicationAdapter = ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;
type SourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SourceExportRecord = NonNullable<Awaited<ReturnType<SourceExportStore['load']>>>;
type PrepareJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type PrepareTargetTransportStrategy = SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
type PrepareTargetJobResponse =
    | SessionHandoffPrepareTargetResultGetResponse
    | Readonly<{
        handoffId: string;
        status: SessionHandoffStatus;
    }>
    | Readonly<{
        ok: false;
        errorCode: 'direct_peer_transfer_unavailable' | 'missing_handoff_metadata_v2';
        error: string;
    }>;
type PrepareTargetStatusResponse =
    | Readonly<{
        handoffId: string;
        status: SessionHandoffStatus;
    }>
    | Readonly<{
        ok: false;
        errorCode: 'not_found';
    }>;
type PrepareTargetResultResponse =
    | SessionHandoffPrepareTargetResultGetResponse
    | Readonly<{
        ok: false;
        errorCode: 'not_found' | SessionHandoffStatus['status'];
        error?: string;
    }>;

type DirectPeerTransferRequester = Readonly<{
    requestPayloadFile?: (input: Readonly<{
        transferId: string;
        endpointCandidates: readonly TransferEndpointCandidate[];
        destinationPath: string;
    }>) => Promise<Readonly<{ destinationPath: string }>>;
}>;

type ImportSessionBundleResult = Readonly<{
    remoteSessionId: string;
    directSource: unknown;
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
    resume: SessionHandoffResumePlan;
}>;

type PrepareTargetDependencies = Readonly<{
    activeServerDir: string;
    sourceExportStore: SourceExportStore;
    waitForPersistedSourceExport?: (
        handoffId: string,
        predicate: (record: SourceExportRecord) => boolean,
    ) => Promise<SourceExportRecord | null>;
    workspaceReplicationAdapter: WorkspaceReplicationAdapter;
    workspaceReplicationTransfers: ReturnType<WorkspaceReplicationAdapter['createReplicationTransfers']>;
    importSessionBundle: (
        providerBundle: SessionHandoffProviderBundle,
        targetPath: string,
        mode: 'persisted' | 'direct',
    ) => Promise<ImportSessionBundleResult>;
    resolveProviderBundle: (params: Readonly<{
        request: SessionHandoffPrepareTargetRequest;
        actualTransportStrategy: PrepareTargetTransportStrategy;
        handoffMetadataV2: SessionHandoffMetadataV2 | undefined;
    }>) => Promise<SessionHandoffProviderBundle | null>;
    resolveWorkspaceReplicationMetadata: (params: Readonly<{
        request: SessionHandoffPrepareTargetRequest;
        actualTransportStrategy: PrepareTargetTransportStrategy;
        workspaceTransfer: SessionHandoffWorkspaceTransfer | undefined;
        handoffMetadataV2: SessionHandoffMetadataV2 | undefined;
    }>) => Promise<SessionHandoffWorkspaceReplicationMetadata | undefined>;
    machineTransferChannel?: MachineTransferChannel;
    directPeerTransfer?: DirectPeerTransferRequester;
    workspaceReplicationBlobPackTargetBytes: number;
    workspaceReplicationBlobPackMaxBlobs: number;
    workspaceReplicationBlobPackMaxSingleBlobBytes: number;
    nowMs?: () => number;
    randomId?: () => string;
}>;

function directPeerTransferUnavailable() {
    return {
        ok: false,
        errorCode: 'direct_peer_transfer_unavailable',
        error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
    } as const;
}

function missingHandoffMetadataV2() {
    return {
        ok: false,
        errorCode: 'missing_handoff_metadata_v2',
        error: 'Handoff metadata V2 is required to prepare the target',
    } as const;
}

function isMachineTransferTimeoutErrorMessage(message: string): boolean {
    return message.startsWith('Timed out waiting for machine transfer ');
}

function buildPrepareJobId(handoffId: string): string {
    return `prepare_${handoffId}`;
}

function buildSourceExportOnlyPrepareJobId(handoffId: string): string {
    return `source_${handoffId}`;
}

function isTerminalHandoffStatus(status: SessionHandoffStatus): boolean {
    return status.status === 'ready_for_cutover'
        || status.status === 'completed'
        || status.status === 'aborted'
        || status.status === 'failed'
        || status.status === 'awaiting_recovery';
}

function buildPreparePendingStatus(input: Readonly<{
    handoffId: string;
    jobId: string;
    transportStrategy: PrepareTargetTransportStrategy;
    recoveryActions: SessionHandoffStatus['recoveryActions'];
    phaseDetail: string;
}>): SessionHandoffStatus {
    return {
        handoffId: input.handoffId,
        jobId: input.jobId,
        status: 'pending',
        phase: 'staging_target',
        transportStrategy: input.transportStrategy,
        recoveryActions: [...input.recoveryActions],
        progress: {
            updatedAtMs: Date.now(),
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
                phaseDetail: input.phaseDetail,
            },
            resumable: false,
        },
    };
}

function mapWorkspaceReplicationJobCheckpointToHandoffCheckpoint(
    checkpoint: string,
): NonNullable<SessionHandoffStatus['progress']>['checkpoint'] {
    switch (checkpoint) {
        case 'job_created':
        case 'relationship_resolved':
        case 'missing_digests_negotiated':
            return 'plan';
        case 'blob_transfer_started':
            return 'transfer_blobs';
        case 'blob_transfer_completed':
        case 'apply_started':
        case 'apply_completed':
            return 'apply';
        case 'baseline_committed':
            return 'finalize';
        default:
            return 'plan';
    }
}

function mergeWorkspaceReplicationProgressIntoHandoffStatus(params: Readonly<{
    baseStatus: SessionHandoffStatus;
    job: Readonly<{
        updatedAtMs: number;
        status: Readonly<{
            checkpoint: string;
            phase: string;
            progressCounters: Readonly<{
                plannedFiles: number;
                plannedBytes: number;
                transferredFiles: number;
                transferredBytes: number;
            }>;
        }>;
    }>;
}>): SessionHandoffStatus {
    const baseProgress = params.baseStatus.progress;
    const counters = params.job.status.progressCounters;
    const checkpoint = mapWorkspaceReplicationJobCheckpointToHandoffCheckpoint(params.job.status.checkpoint);

    return {
        ...params.baseStatus,
        progress: {
            updatedAtMs: params.job.updatedAtMs,
            checkpoint,
            planned: {
                totalFiles: counters.plannedFiles,
                totalBytes: counters.plannedBytes,
            },
            transferred: {
                files: counters.transferredFiles,
                bytes: counters.transferredBytes,
            },
            current: {
                ...(baseProgress?.current ?? {}),
                phaseDetail: `workspace_replication:${params.job.status.phase}`,
            },
            resumable: baseProgress?.resumable ?? false,
        },
    };
}

function buildWorkspaceReplicationStatusProgress(params: Readonly<{
    previousManifest: WorkspaceManifest;
    nextManifest: WorkspaceManifest;
    blobCount: number;
    checkpoint: NonNullable<SessionHandoffStatus['progress']>['checkpoint'];
    phaseDetail: string;
}>): Pick<SessionHandoffStatus, 'progress' | 'workspacePreflightSummary'> {
    const comparison = compareWorkspaceManifests({
        previousManifest: params.previousManifest,
        nextManifest: params.nextManifest,
    });
    const transferredFileEntries = [
        ...comparison.added,
        ...comparison.changed.map((entry) => entry.next),
    ].filter((entry): entry is Extract<WorkspaceManifest['entries'][number], { kind: 'file' }> => entry.kind === 'file');
    const totalBytes = transferredFileEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

    return {
        workspacePreflightSummary: {
            addedPathsCount: comparison.added.length,
            changedPathsCount: comparison.changed.length,
            removedPathsCount: comparison.removed.length,
            totalBytes,
        },
        progress: {
            updatedAtMs: Date.now(),
            checkpoint: params.checkpoint,
            planned: {
                totalFiles: transferredFileEntries.length,
                totalBytes,
                added: comparison.added.length,
                changed: comparison.changed.length,
                removed: comparison.removed.length,
            },
            transferred: {
                files: transferredFileEntries.length,
                bytes: totalBytes,
                blobs: params.blobCount,
            },
            current: {
                phaseDetail: params.phaseDetail,
            },
            resumable: false,
        },
    };
}

function buildPrepareJobRecord(input: Readonly<{
    jobId: string;
    handoffId: string;
    status: SessionHandoffStatus;
    prepareTargetResult?: SessionHandoffPrepareTargetResultGetResponse;
    createdAtMs: number;
    updatedAtMs?: number;
    cancelRequestedAtMs?: number;
    abortedAtMs?: number;
    completedAtMs?: number;
    failedAtMs?: number;
    lastErrorMessage?: string;
    workspaceReplicationJobId?: string;
}>): SessionHandoffPrepareTargetJobRecordInput {
    return {
        jobId: input.jobId,
        handoffId: input.handoffId,
        createdAtMs: input.createdAtMs,
        updatedAtMs: input.updatedAtMs ?? input.createdAtMs,
        ...(input.cancelRequestedAtMs ? { cancelRequestedAtMs: input.cancelRequestedAtMs } : {}),
        ...(input.abortedAtMs ? { abortedAtMs: input.abortedAtMs } : {}),
        ...(input.completedAtMs ? { completedAtMs: input.completedAtMs } : {}),
        ...(input.failedAtMs ? { failedAtMs: input.failedAtMs } : {}),
        ...(input.lastErrorMessage ? { lastErrorMessage: input.lastErrorMessage } : {}),
        ...(input.workspaceReplicationJobId ? { workspaceReplicationJobId: input.workspaceReplicationJobId } : {}),
        status: input.status,
        ...(input.prepareTargetResult ? { prepareTargetResult: input.prepareTargetResult } : {}),
    };
}

async function waitForPrepareJobFastPath(runPromise: Promise<void>): Promise<'completed' | 'pending'> {
    return await Promise.race([
        runPromise.then(() => 'completed' as const),
        new Promise<'pending'>((resolve) => {
            setTimeout(() => resolve('pending'), PREPARE_JOB_FAST_PATH_BUDGET_MS);
        }),
    ]);
}

export function createSessionHandoffPrepareTargetRuntime(params: PrepareTargetDependencies) {
    const nowMs = params.nowMs ?? (() => Date.now());
    const randomId = params.randomId ?? randomUUID;
    const prepareJobStore: PrepareJobStore = createSessionHandoffPrepareTargetJobStore({
        activeServerDir: params.activeServerDir,
    });
    const activePrepareJobs = new Map<string, Promise<void>>();
    const prepareTargetJobLeaseOwnerId = `cli-daemon:${process.pid}:${randomId()}`;
    const prepareTargetJobLeaseTtlMs = resolveSessionHandoffPrepareTargetJobLeaseTtlMs();
    const prepareTargetJobRecoveryGraceMs = Math.min(prepareTargetJobLeaseTtlMs, PREPARE_TARGET_JOB_RECOVERY_GRACE_MAX_MS);

    const readPersistedJob = async (handoffId: string): Promise<SessionHandoffPrepareTargetJobRecord | null> => {
        return await prepareJobStore.findByHandoffId(handoffId);
    };

    const maybeRecoverPrepareTargetJobMissingRunner = async (
        job: SessionHandoffPrepareTargetJobRecord,
    ): Promise<SessionHandoffPrepareTargetJobRecord> => {
        if (
            job.status.phase !== 'staging_target'
            || (job.status.status !== 'pending' && job.status.status !== 'in_progress')
        ) {
            return job;
        }
        if (activePrepareJobs.has(job.jobId)) {
            return job;
        }

        const probeNowMs = nowMs();
        if (job.updatedAtMs + prepareTargetJobRecoveryGraceMs > probeNowMs) {
            return job;
        }
        const probeOwnerId = `status-probe:${process.pid}:${randomId()}`;
        const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
            activeServerDir: params.activeServerDir,
            jobId: job.jobId,
            ownerId: probeOwnerId,
            nowMs: probeNowMs,
            ttlMs: 5_000,
        });

        if (!leaseAttempt.acquired) {
            return job;
        }

        await releaseSessionHandoffPrepareTargetJobLease({
            activeServerDir: params.activeServerDir,
            jobId: job.jobId,
            ownerId: probeOwnerId,
        }).catch(() => undefined);

        const recovered = await prepareJobStore.update(job.jobId, (current) => {
            const { schemaVersion: _schemaVersion, ...rest } = current;
            const previousProgress = rest.status.progress;
            const nextProgress = previousProgress
                ? {
                    ...previousProgress,
                    updatedAtMs: probeNowMs,
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
                    updatedAtMs: probeNowMs,
                    abortedAtMs: rest.abortedAtMs ?? probeNowMs,
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
                updatedAtMs: probeNowMs,
                failedAtMs: rest.failedAtMs ?? probeNowMs,
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

    const prepareTarget = async (request: SessionHandoffPrepareTargetRequest): Promise<PrepareTargetJobResponse> => {
        const persistedJob = await readPersistedJob(request.handoffId);
        if (persistedJob?.prepareTargetResult) {
            return persistedJob.prepareTargetResult;
        }
        const persistedStatusCode = persistedJob?.status.status;
        const isFinalPersistedStatus = persistedStatusCode === 'ready_for_cutover' || persistedStatusCode === 'completed';
        const isRetryablePersistedStatus =
            persistedStatusCode === 'awaiting_recovery'
            || persistedStatusCode === 'failed'
            || persistedStatusCode === 'aborted';
        if (persistedJob && isFinalPersistedStatus) {
            return {
                handoffId: request.handoffId,
                status: persistedJob.status,
            };
        }
        if (persistedJob && !isTerminalHandoffStatus(persistedJob.status) && activePrepareJobs.has(persistedJob.jobId)) {
            return {
                handoffId: request.handoffId,
                status: persistedJob.status,
            };
        }

        const jobId = persistedJob?.jobId ?? buildPrepareJobId(request.handoffId);
        const pendingUpdatedAtMs = nowMs();
        const createdAtMs = persistedJob?.createdAtMs ?? pendingUpdatedAtMs;
        let workspaceReplicationJobId: string | undefined = isRetryablePersistedStatus
            ? undefined
            : persistedJob?.workspaceReplicationJobId;
        const isRestartingPersistedJob = Boolean(
            persistedJob
            && !isTerminalHandoffStatus(persistedJob.status)
            && !activePrepareJobs.has(persistedJob.jobId),
        );
        const pendingStatus = buildPreparePendingStatus({
            handoffId: request.handoffId,
            jobId,
            transportStrategy: request.negotiatedTransportStrategy,
            recoveryActions: [],
            phaseDetail: isRestartingPersistedJob
                ? 'resuming_after_restart'
                : isRetryablePersistedStatus
                    ? 'retrying_after_recovery'
                    : 'importing_workspace',
        });
        let actualTransportStrategy = request.negotiatedTransportStrategy;

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
            await prepareJobStore.write(mergedJobRecord);
        };

        await persistJobRecord(buildPrepareJobRecord({
            jobId,
            handoffId: request.handoffId,
            createdAtMs,
            updatedAtMs: pendingUpdatedAtMs,
            status: pendingStatus,
        }));

        const existingActiveJob = activePrepareJobs.get(jobId);
        let runJob = existingActiveJob;
        if (!runJob) {
            runJob = (async () => {
                let leaseAcquired = false;
                let leaseHeartbeat: Readonly<{ stop: () => Promise<void> }> | null = null;

                try {
                    const assertPrepareJobNotCancelled = async (): Promise<void> => {
                        const latestJob = await prepareJobStore.read(jobId);
                        if (latestJob?.cancelRequestedAtMs) {
                            throw new Error(`Session handoff prepare aborted: ${request.handoffId}`);
                        }
                    };
                    const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
                        activeServerDir: params.activeServerDir,
                        jobId,
                        ownerId: prepareTargetJobLeaseOwnerId,
                        nowMs: nowMs(),
                        ttlMs: prepareTargetJobLeaseTtlMs,
                    });
                    if (!leaseAttempt.acquired) {
                        return;
                    }

                    leaseAcquired = true;
                    leaseHeartbeat = startSessionHandoffPrepareTargetJobLeaseHeartbeat({
                        activeServerDir: params.activeServerDir,
                        jobId,
                        ownerId: prepareTargetJobLeaseOwnerId,
                        ttlMs: prepareTargetJobLeaseTtlMs,
                        nowMs,
                    });

                    try {
                        const wasCancelledBeforeWorkspaceImport = await prepareJobStore.read(jobId);
                        if (wasCancelledBeforeWorkspaceImport?.cancelRequestedAtMs) {
                            const abortedAtMs = nowMs();
                            await persistJobRecord(buildPrepareJobRecord({
                                jobId,
                                handoffId: request.handoffId,
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
                        const persistedHandoffMetadataV2 = request.handoffMetadataV2;
                        const localSourceExport =
                            !params.machineTransferChannel && !params.directPeerTransfer && params.waitForPersistedSourceExport
                                ? await params.waitForPersistedSourceExport(
                                    request.handoffId,
                                    (record) => {
                                        if (!record.providerBundle) {
                                            return false;
                                        }
                                        if (resolvedWorkspaceTransfer?.enabled !== true) {
                                            return true;
                                        }
                                        return Boolean(record.workspaceManifest && record.workspaceSourceRootPath);
                                    },
                                )
                                : await params.sourceExportStore.load(request.handoffId);
                        const localProviderBundle =
                            localSourceExport?.providerBundle
                                ? await readSessionHandoffProviderBundleFile(localSourceExport.providerBundle.filePath).catch(() => null)
                                : null;
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
                                : null;

                        const allowServerRoutedFallback = request.allowServerRoutedFallback !== false;
                        const canFallbackToServerRouted = allowServerRoutedFallback && params.machineTransferChannel !== undefined;

                        const hasProviderBundleTransferPublication =
                            persistedHandoffMetadataV2?.providerBundleTransferPublication !== undefined;
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
                        if (
                            needsWorkspaceReplicationMetadata
                            && !localWorkspaceReplicationMetadata
                            && (
                                persistedHandoffMetadataV2?.workspaceReplicationSourceRootPath === undefined
                                || persistedHandoffMetadataV2.workspaceReplicationManifestTransferPublication === undefined
                            )
                        ) {
                            throw new Error(missingHandoffMetadataV2().error);
                        }

                        if (actualTransportStrategy === 'direct_peer') {
                            const directPeerRequester = params.directPeerTransfer?.requestPayloadFile;
                            const providerEndpointCandidates =
                                persistedHandoffMetadataV2?.providerBundleTransferPublication?.endpointCandidates;
                            const providerCandidatesFallback = providerEndpointCandidates ?? request.endpointCandidates;
                            const manifestEndpointCandidates =
                                persistedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates
                                ?? request.endpointCandidates;

                            const checkNowMs = nowMs();
                            const hasUsableProviderEndpointCandidates =
                                Array.isArray(providerCandidatesFallback)
                                && providerCandidatesFallback.some((candidate) => candidate.expiresAt >= checkNowMs);
                            const hasUsableManifestEndpointCandidates =
                                Array.isArray(manifestEndpointCandidates)
                                && manifestEndpointCandidates.some((candidate) => candidate.expiresAt >= checkNowMs);

                            const canUseDirectPeerForProviderBundle =
                                Boolean(localProviderBundle)
                                || (
                                    typeof directPeerRequester === 'function'
                                    && hasUsableProviderEndpointCandidates
                                );
                            const canUseDirectPeerForWorkspaceManifest =
                                resolvedWorkspaceTransfer?.enabled !== true
                                || !needsWorkspaceReplicationMetadata
                                || Boolean(localWorkspaceReplicationMetadata)
                                || (
                                    typeof directPeerRequester === 'function'
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

                        const providerBundle =
                            localProviderBundle
                            ?? await params.resolveProviderBundle({
                                request,
                                actualTransportStrategy,
                                handoffMetadataV2: persistedHandoffMetadataV2,
                            });
                        if (!providerBundle) {
                            throw new Error('Invalid session handoff provider bundle');
                        }

                        const persistedWorkspaceReplicationMetadata =
                            localWorkspaceReplicationMetadata
                            ?? await params.resolveWorkspaceReplicationMetadata({
                                request,
                                actualTransportStrategy,
                                workspaceTransfer: resolvedWorkspaceTransfer,
                                handoffMetadataV2: persistedHandoffMetadataV2,
                            });
                        const {
                            currentTargetManifest,
                            sourceOffer,
                            importedWorkspace,
                        } = await params.workspaceReplicationAdapter.prepareTargetWorkspace({
                            targetPath: normalizeSessionHandoffTargetPathForLocalMachine({
                                requestedTargetPath: request.targetPath,
                                homeDir: resolveSessionHandoffLocalHomeDir({
                                    activeServerDir: params.activeServerDir,
                                    fallbackHomeDir: os.homedir(),
                                }),
                            }),
                            activeServerDir: params.activeServerDir,
                            actualTransportStrategy,
                            handoffId: request.handoffId,
                            sourceMachineId: request.sourceMachineId,
                            targetMachineId: request.targetMachineId,
                            workspaceTransfer: resolvedWorkspaceTransfer,
                            metadata: persistedWorkspaceReplicationMetadata ?? undefined,
                            directPeerManifestEndpointCandidates:
                                persistedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates,
                            machineTransferChannel: params.machineTransferChannel,
                            transfers: params.workspaceReplicationTransfers,
                            blobPackTargetBytes: params.workspaceReplicationBlobPackTargetBytes,
                            blobPackMaxBlobs: params.workspaceReplicationBlobPackMaxBlobs,
                            blobPackMaxSingleBlobBytes: params.workspaceReplicationBlobPackMaxSingleBlobBytes,
                            onWorkspaceReplicationJobStarted: async (startedWorkspaceReplicationJobId: string) => {
                                workspaceReplicationJobId = workspaceReplicationJobId ?? startedWorkspaceReplicationJobId;
                                await prepareJobStore.update(jobId, (currentRecord) => {
                                    const { schemaVersion: _schemaVersion, ...rest } = currentRecord;
                                    return {
                                        ...rest,
                                        workspaceReplicationJobId: rest.workspaceReplicationJobId ?? startedWorkspaceReplicationJobId,
                                        updatedAtMs: nowMs(),
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
                            handoffId: request.handoffId,
                            createdAtMs,
                            updatedAtMs: nowMs(),
                            status: {
                                ...buildPreparePendingStatus({
                                    handoffId: request.handoffId,
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
                            const abortedAtMs = nowMs();
                            await persistJobRecord(buildPrepareJobRecord({
                                jobId,
                                handoffId: request.handoffId,
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

                        const imported = await params.importSessionBundle(
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
                        const readyForCutoverStatus: SessionHandoffStatus = workspaceStatusProgress && sourceOffer
                            ? {
                                ...readyForCutoverStatusBase,
                                ...buildWorkspaceReplicationStatusProgress({
                                    previousManifest: currentTargetManifest,
                                    nextManifest: sourceOffer.manifest,
                                    blobCount: sourceOffer.blobIndex.length,
                                    checkpoint: 'import_session',
                                    phaseDetail: 'ready_for_cutover',
                                }),
                            }
                            : {
                                ...readyForCutoverStatusBase,
                                progress: {
                                    updatedAtMs: nowMs(),
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
                            handoffId: request.handoffId,
                            status: readyForCutoverStatus,
                            remoteSessionId: imported.remoteSessionId,
                            directSource,
                            ...(imported.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: imported.agentRuntimeDescriptorV1 } : {}),
                            resume: imported.resume,
                        };
                        const afterImportJob = await prepareJobStore.read(jobId);
                        if (afterImportJob?.cancelRequestedAtMs) {
                            const abortedAtMs = nowMs();
                            await persistJobRecord(buildPrepareJobRecord({
                                jobId,
                                handoffId: request.handoffId,
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
                        const completedAtMs = nowMs();
                        await persistJobRecord(buildPrepareJobRecord({
                            jobId,
                            handoffId: request.handoffId,
                            createdAtMs,
                            updatedAtMs: completedAtMs,
                            completedAtMs,
                            status: readyForCutoverStatus,
                            prepareTargetResult: prepareResult,
                        }));
                    } catch (error) {
                        const failedAtMs = nowMs();
                        const currentJob = await prepareJobStore.read(jobId);
                        const failedStatus: SessionHandoffStatus = {
                            ...(currentJob?.status ?? pendingStatus),
                            status: currentJob?.cancelRequestedAtMs ? 'aborted' : 'awaiting_recovery',
                        };
                        await persistJobRecord(buildPrepareJobRecord({
                            jobId,
                            handoffId: request.handoffId,
                            createdAtMs,
                            updatedAtMs: failedAtMs,
                            ...(currentJob?.cancelRequestedAtMs
                                ? { cancelRequestedAtMs: currentJob.cancelRequestedAtMs, abortedAtMs: failedAtMs }
                                : { failedAtMs }),
                            lastErrorMessage: error instanceof Error ? error.message : 'Failed to prepare handoff target',
                            status: failedStatus,
                        }));
                    }
                } finally {
                    await leaseHeartbeat?.stop().catch(() => undefined);
                    if (leaseAcquired) {
                        await releaseSessionHandoffPrepareTargetJobLease({
                            activeServerDir: params.activeServerDir,
                            jobId,
                            ownerId: prepareTargetJobLeaseOwnerId,
                        }).catch(() => undefined);
                    }
                    if (activePrepareJobs.get(jobId) === runJob) {
                        activePrepareJobs.delete(jobId);
                    }
                }
            })();
        }

        activePrepareJobs.set(jobId, runJob);

        const fastPathResult = await waitForPrepareJobFastPath(runJob);
        if (fastPathResult === 'completed') {
            const completedJob = await prepareJobStore.read(jobId);
            if (completedJob?.prepareTargetResult) {
                return completedJob.prepareTargetResult;
            }
            if (completedJob?.status.status === 'awaiting_recovery' && completedJob.lastErrorMessage) {
                if (isMachineTransferTimeoutErrorMessage(completedJob.lastErrorMessage)) {
                    return {
                        handoffId: request.handoffId,
                        status: pendingStatus,
                    };
                }
                if (completedJob.lastErrorMessage === directPeerTransferUnavailable().error) {
                    return directPeerTransferUnavailable();
                }
                if (completedJob.lastErrorMessage === missingHandoffMetadataV2().error) {
                    return missingHandoffMetadataV2();
                }
                throw new Error(completedJob.lastErrorMessage);
            }
            if (completedJob) {
                return {
                    handoffId: request.handoffId,
                    status: completedJob.status,
                };
            }
        }

        return {
            handoffId: request.handoffId,
            status: pendingStatus,
        };
    };

    const getStatus = async (handoffId: string): Promise<PrepareTargetStatusResponse> => {
        let persistedJob = await readPersistedJob(handoffId);
        if (persistedJob) {
            persistedJob = await maybeRecoverPrepareTargetJobMissingRunner(persistedJob);
        }
        if (persistedJob) {
            const baseStatus = persistedJob.status;
            if (
                persistedJob.workspaceReplicationJobId
                && baseStatus.status === 'pending'
                && baseStatus.phase === 'staging_target'
            ) {
                const job = await params.workspaceReplicationAdapter.readWorkspaceReplicationJobStatus({
                    activeServerDir: params.activeServerDir,
                    jobId: persistedJob.workspaceReplicationJobId,
                });
                if (job) {
                    return {
                        handoffId,
                        status: mergeWorkspaceReplicationProgressIntoHandoffStatus({
                            baseStatus,
                            job,
                        }),
                    };
                }
            }
            return { handoffId, status: baseStatus };
        }
        const persistedSourceExport = await params.sourceExportStore.load(handoffId);
        if (persistedSourceExport) {
            return {
                handoffId,
                status: {
                    handoffId,
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
            };
        }
        return { ok: false, errorCode: 'not_found' };
    };

    const getResult = async (handoffId: string): Promise<PrepareTargetResultResponse> => {
        let persistedJob = await readPersistedJob(handoffId);
        if (persistedJob) {
            persistedJob = await maybeRecoverPrepareTargetJobMissingRunner(persistedJob);
        }
        if (persistedJob?.prepareTargetResult) {
            return persistedJob.prepareTargetResult;
        }
        if (!persistedJob) {
            return { ok: false, errorCode: 'not_found' };
        }
        if (!isTerminalHandoffStatus(persistedJob.status)) {
            return { ok: false, errorCode: 'not_found' };
        }

        const statusCode = persistedJob.status.status;
        if (statusCode === 'ready_for_cutover') {
            return {
                ok: false,
                errorCode: 'awaiting_recovery',
                error: persistedJob.lastErrorMessage ?? 'Prepare-target result missing for ready_for_cutover job',
            };
        }
        if (statusCode === 'completed') {
            return {
                ok: false,
                errorCode: 'awaiting_recovery',
                error: persistedJob.lastErrorMessage ?? 'Prepare-target job completed without a ready_for_cutover result',
            };
        }
        return {
            ok: false,
            errorCode: statusCode,
            error: persistedJob.lastErrorMessage ?? `Prepare-target job is ${statusCode}`,
        };
    };

    const writeCommittedStatus = async (params: Readonly<{
        handoffId: string;
        fallbackStatus: SessionHandoffStatus;
        sourceExport?: Pick<SourceExportRecord, 'exportedAtMs'>;
    }>): Promise<SessionHandoffStatus | null> => {
        const persistedJob = await readPersistedJob(params.handoffId);
        const committedAtMs = nowMs();
        const status: SessionHandoffStatus = {
            ...params.fallbackStatus,
            status: 'completed',
            phase: 'finalizing',
        };
        if (persistedJob) {
            await prepareJobStore.write(buildPrepareJobRecord({
                jobId: persistedJob.jobId,
                handoffId: params.handoffId,
                createdAtMs: persistedJob.createdAtMs,
                updatedAtMs: committedAtMs,
                completedAtMs: committedAtMs,
                workspaceReplicationJobId: persistedJob.workspaceReplicationJobId,
                status,
                ...(persistedJob.prepareTargetResult ? {
                    prepareTargetResult: {
                        ...persistedJob.prepareTargetResult,
                        status,
                    },
                } : {}),
            }));
            return status;
        }
        if (params.sourceExport) {
            const jobId = buildSourceExportOnlyPrepareJobId(params.handoffId);
            const durableStatus: SessionHandoffStatus = { ...status, jobId };
            await prepareJobStore.write(buildPrepareJobRecord({
                jobId,
                handoffId: params.handoffId,
                createdAtMs: params.sourceExport.exportedAtMs,
                updatedAtMs: committedAtMs,
                completedAtMs: committedAtMs,
                status: durableStatus,
            }));
            return durableStatus;
        }
        return null;
    };

    const writeAbortedStatus = async (input: Readonly<{
        handoffId: string;
        fallbackStatus: SessionHandoffStatus;
        sourceExport?: Pick<SourceExportRecord, 'exportedAtMs'>;
    }>): Promise<SessionHandoffStatus | null> => {
        const persistedJob = await readPersistedJob(input.handoffId);
        if (persistedJob?.workspaceReplicationJobId) {
            await params.workspaceReplicationAdapter.abortWorkspaceReplicationJob({
                activeServerDir: params.activeServerDir,
                jobId: persistedJob.workspaceReplicationJobId,
            }).catch(() => undefined);
        }

        const abortedAtMs = nowMs();
        if (persistedJob) {
            const status: SessionHandoffStatus = {
                ...persistedJob.status,
                status: 'aborted',
            };
            await prepareJobStore.write(buildPrepareJobRecord({
                jobId: persistedJob.jobId,
                handoffId: input.handoffId,
                createdAtMs: persistedJob.createdAtMs,
                updatedAtMs: abortedAtMs,
                cancelRequestedAtMs: persistedJob.cancelRequestedAtMs ?? abortedAtMs,
                abortedAtMs,
                workspaceReplicationJobId: persistedJob.workspaceReplicationJobId,
                ...(persistedJob.failedAtMs ? { failedAtMs: persistedJob.failedAtMs } : {}),
                ...(persistedJob.lastErrorMessage ? { lastErrorMessage: persistedJob.lastErrorMessage } : {}),
                status,
                ...(persistedJob.prepareTargetResult ? {
                    prepareTargetResult: {
                        ...persistedJob.prepareTargetResult,
                        status,
                    },
                } : {}),
            }));
            return status;
        }

        const status: SessionHandoffStatus = {
            ...input.fallbackStatus,
            status: 'aborted',
            phase: input.fallbackStatus.phase,
        };
        if (input.sourceExport) {
            const jobId = buildSourceExportOnlyPrepareJobId(input.handoffId);
            const durableStatus: SessionHandoffStatus = { ...status, jobId };
            await prepareJobStore.write(buildPrepareJobRecord({
                jobId,
                handoffId: input.handoffId,
                createdAtMs: input.sourceExport.exportedAtMs,
                updatedAtMs: abortedAtMs,
                cancelRequestedAtMs: abortedAtMs,
                abortedAtMs,
                status: durableStatus,
            }));
            return durableStatus;
        }
        return null;
    };

    const writeStartRecoveryStatus = async (params: Readonly<{
        handoffId: string;
        errorMessage: string;
        recoveryStatus: SessionHandoffStatus;
    }>): Promise<void> => {
        const failedAtMs = nowMs();
        await prepareJobStore.write({
            jobId: `start_${params.handoffId}`,
            handoffId: params.handoffId,
            createdAtMs: failedAtMs,
            updatedAtMs: failedAtMs,
            failedAtMs,
            lastErrorMessage: params.errorMessage,
            status: {
                ...params.recoveryStatus,
                jobId: `start_${params.handoffId}`,
            },
        });
    };

    return {
        prepareTarget,
        getStatus,
        getResult,
        readPersistedJob,
        writeCommittedStatus,
        writeAbortedStatus,
        writeStartRecoveryStatus,
    };
}
