import { SessionHandoffStatusGetRequestSchema, type SessionHandoffStatus } from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffWorkspaceReplicationAdapter } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;

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
      return 'stage_target';
    case 'apply_started':
    case 'apply_completed':
      return 'apply';
    case 'baseline_committed':
      return 'finalize';
    default:
      return 'plan';
  }
}

function clampNonNegativeDifference(left: number, right: number): number {
  return Math.max(0, left - right);
}

function buildHandoffProgressCountsFromWorkspaceReplicationCounters(counters: Readonly<{
  plannedFiles: number;
  plannedBytes: number;
  transferredFiles: number;
  transferredBytes: number;
  appliedFiles: number;
  appliedBytes: number;
}>): Readonly<{
  planned: Readonly<{ totalFiles: number; totalBytes: number }>;
  transferred: Readonly<{ files: number; bytes: number }>;
  applied: Readonly<{ files: number; bytes: number }>;
  remaining: Readonly<{ files: number; bytes: number }>;
}> {
  return {
    planned: {
      totalFiles: counters.plannedFiles,
      totalBytes: counters.plannedBytes,
    },
    transferred: {
      files: counters.transferredFiles,
      bytes: counters.transferredBytes,
    },
    applied: {
      files: counters.appliedFiles,
      bytes: counters.appliedBytes,
    },
    remaining: {
      files: clampNonNegativeDifference(counters.plannedFiles, counters.transferredFiles),
      bytes: clampNonNegativeDifference(counters.plannedBytes, counters.transferredBytes),
    },
  };
}

function normalizeHandoffProgress(progress: NonNullable<SessionHandoffStatus['progress']> | undefined): NonNullable<SessionHandoffStatus['progress']> | undefined {
  if (!progress) {
    return progress;
  }

  const plannedFiles = typeof progress.planned.totalFiles === 'number' ? progress.planned.totalFiles : 0;
  const plannedBytes = typeof progress.planned.totalBytes === 'number' ? progress.planned.totalBytes : 0;
  const transferredFiles = typeof progress.transferred.files === 'number' ? progress.transferred.files : 0;
  const transferredBytes = typeof progress.transferred.bytes === 'number' ? progress.transferred.bytes : 0;

  return {
    ...progress,
    applied: progress.applied ?? {
      files: 0,
      bytes: 0,
    },
    remaining: progress.remaining ?? {
      files: clampNonNegativeDifference(plannedFiles, transferredFiles),
      bytes: clampNonNegativeDifference(plannedBytes, transferredBytes),
    },
  };
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
        appliedFiles: number;
        appliedBytes: number;
      }>;
    }>;
  }>;
}>): SessionHandoffStatus {
  const baseProgress = params.baseStatus.progress;
  const counters = params.job.status.progressCounters;
  const checkpoint = mapWorkspaceReplicationJobCheckpointToHandoffCheckpoint(params.job.status.checkpoint);
  const progressCounts = buildHandoffProgressCountsFromWorkspaceReplicationCounters(counters);

  return {
    ...params.baseStatus,
    progress: {
      updatedAtMs: params.job.updatedAtMs,
      checkpoint,
      planned: progressCounts.planned,
      transferred: progressCounts.transferred,
      applied: progressCounts.applied,
      remaining: progressCounts.remaining,
      current: {
        ...(baseProgress?.current ?? {}),
        phaseDetail: `workspace_replication:${params.job.status.phase}`,
      },
      resumable: baseProgress?.resumable ?? false,
    },
  };
}

export type RegisterSessionHandoffStatusGetRpcHandlerInput = Readonly<{
  activeServerDir: string;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  workspaceReplicationAdapter: SessionHandoffWorkspaceReplicationAdapter;
  readPersistedPrepareJob: (params: Readonly<{
    handoffId: string;
    jobStore: SessionHandoffPrepareTargetJobStore;
  }>) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  buildStartPendingStatus: (input: Readonly<{
    handoffId: string;
    sourceStopState: 'stopped' | 'already_inactive';
  }>) => SessionHandoffStatus;
  invalidRequest: () => Readonly<{
    ok: false;
    errorCode: 'invalid_request';
  }>;
}>;

export function createSessionHandoffStatusGetActionHandler(
  params: RegisterSessionHandoffStatusGetRpcHandlerInput,
): (raw: unknown) => Promise<unknown> {
  const {
    activeServerDir,
    prepareJobStore,
    sourceExportStore,
    workspaceReplicationAdapter,
    readPersistedPrepareJob,
    buildStartPendingStatus,
    invalidRequest,
  } = params;

  return async (raw: unknown) => {
    const parsed = SessionHandoffStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    if (persistedJob) {
      const baseStatus = persistedJob.status;
      if (
        persistedJob.workspaceReplicationJobId
        && baseStatus.status === 'pending'
        && baseStatus.phase === 'staging_target'
      ) {
        const job = await workspaceReplicationAdapter.readWorkspaceReplicationJobStatus({
          activeServerDir,
          jobId: persistedJob.workspaceReplicationJobId,
        });
        if (job) {
          return {
            handoffId: parsed.data.handoffId,
            ...(persistedJob.schemaVersion === 2
              ? { transitionRevision: persistedJob.transitionRevision }
              : {}),
            status: mergeWorkspaceReplicationProgressIntoHandoffStatus({
              baseStatus,
              job,
            }),
          };
        }
      }
      return {
        handoffId: parsed.data.handoffId,
        ...(persistedJob.schemaVersion === 2
          ? { transitionRevision: persistedJob.transitionRevision }
          : {}),
        status: {
          ...baseStatus,
          ...(baseStatus.progress ? { progress: normalizeHandoffProgress(baseStatus.progress) } : {}),
        },
      };
    }
    const persistedSourceExport = await sourceExportStore.load(parsed.data.handoffId);
    if (persistedSourceExport) {
      return {
        handoffId: parsed.data.handoffId,
        status: buildStartPendingStatus({ handoffId: parsed.data.handoffId, sourceStopState: 'already_inactive' }),
      };
    }
    return { ok: false, errorCode: 'not_found' } as const;
  };
}
