import type { WorkspaceReplicationRelationshipStore } from '../relationships/workspaceReplicationRelationshipStore';
import { planWorkspaceReplicationMissingBlobs } from '../transport/planWorkspaceReplicationMissingBlobs';
import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';
import { runWorkspaceReplicationJob } from '../jobs/runWorkspaceReplicationJob';
import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from '../jobs/workspaceReplicationJobStore';
import { WorkspaceReplicationError } from '../workspaceReplicationError';
import { WorkspaceReplicationJobCancelRequestedError } from '../safety/workspaceReplicationJobCancelRequestedError';

function resolveNowMs(now?: () => number): number {
  return now?.() ?? Date.now();
}

function abortRecord(current: WorkspaceReplicationJobRecord, nowMs: number): WorkspaceReplicationJobRecord {
  return {
    ...current,
    cancelRequestedAtMs: current.cancelRequestedAtMs ?? nowMs,
    abortedAtMs: current.abortedAtMs ?? nowMs,
    status: {
      ...current.status,
      status: 'aborted',
    },
  };
}

function isCancelRequestedError(error: unknown): error is WorkspaceReplicationJobCancelRequestedError {
  return error instanceof WorkspaceReplicationJobCancelRequestedError;
}

async function abortJobAndReturn(params: Readonly<{
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
}>): Promise<WorkspaceReplicationJobRecord> {
  const nowMs = resolveNowMs(params.now);
  return await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => abortRecord(record, nowMs),
  });
}

async function markJobFailedAndRethrow(params: Readonly<{
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
  error: unknown;
}>): Promise<never> {
  await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async () => {
      throw params.error;
    },
  });
  // runWorkspaceReplicationJob always throws when the runner throws; this is unreachable.
  throw params.error instanceof Error ? params.error : new Error('Workspace replication job failed');
}

export async function executeWorkspaceReplicationJob(params: Readonly<{
  activeServerDir: string;
  jobStore: WorkspaceReplicationJobStore;
  relationships: WorkspaceReplicationRelationshipStore;
  jobId: string;
  now?: () => number;
  resolveSourceOfferById: (offerId: string) => Promise<WorkspaceReplicationSourceOffer>;
  transferMissingBlobsToTargetCas: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
    missingDigests: readonly string[];
    missingBytes: number;
  }>) => Promise<Readonly<{ transferredFiles: number; transferredBytes: number }>>;
  applyPlan: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
  }>) => Promise<Readonly<{ appliedFiles: number; appliedBytes: number }>>;
  commitBaseline: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
  }>) => Promise<void>;
}>): Promise<WorkspaceReplicationJobRecord> {
  const current = await params.jobStore.read(params.jobId);
  if (!current) {
    throw new WorkspaceReplicationError({
      code: 'job_not_found',
      message: `Workspace replication job not found: ${params.jobId}`,
    });
  }

  if (current.cancelRequestedAtMs || current.status.status === 'aborted') {
    const nowMs = resolveNowMs(params.now);
    return await runWorkspaceReplicationJob({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      run: async (record) => abortRecord(record, nowMs),
    });
  }

  if (!current.relationshipId) {
    return await markJobFailedAndRethrow({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      error: new Error(`Workspace replication job is missing relationshipId: ${current.jobId}`),
    });
  }
  if (!current.offerId) {
    return await markJobFailedAndRethrow({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      error: new Error(`Workspace replication job is missing offerId: ${current.jobId}`),
    });
  }

  const relationship = await params.relationships.read(current.relationshipId);
  if (!relationship) {
    return await markJobFailedAndRethrow({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      error: new Error(`Workspace replication relationship not found: ${current.relationshipId}`),
    });
  }

  const offer = await params.resolveSourceOfferById(current.offerId);

  // 1) relationship resolved
  let latest = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => {
      if (record.cancelRequestedAtMs) {
        return abortRecord(record, resolveNowMs(params.now));
      }
      return {
        ...record,
        relationshipId: relationship.relationshipId,
        status: {
          ...record.status,
          status: 'in_progress',
          phase: 'planning',
          checkpoint: 'relationship_resolved',
        },
      };
    },
  });

  if (latest.cancelRequestedAtMs || latest.status.status === 'aborted') {
    return latest;
  }

  // 2) missing digests negotiated (local CAS contains check)
  const missingPlan = await planWorkspaceReplicationMissingBlobs({
    activeServerDir: params.activeServerDir,
    blobIndex: offer.blobIndex,
  });

  latest = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => {
      if (record.cancelRequestedAtMs) {
        return abortRecord(record, resolveNowMs(params.now));
      }
      return {
        ...record,
        status: {
          ...record.status,
          status: 'in_progress',
          phase: 'negotiate_missing_digests',
          checkpoint: 'missing_digests_negotiated',
          progressCounters: {
            ...record.status.progressCounters,
            plannedFiles: missingPlan.plannedFileCount,
            plannedBytes: missingPlan.plannedByteCount,
          },
        },
      };
    },
  });

  if (latest.cancelRequestedAtMs || latest.status.status === 'aborted') {
    return latest;
  }

  // 3) transfer missing blobs into target CAS
  latest = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => {
      if (record.cancelRequestedAtMs) {
        return abortRecord(record, resolveNowMs(params.now));
      }
      return {
        ...record,
        status: {
          ...record.status,
          status: 'in_progress',
          phase: 'transfer_missing_blobs_to_target_cas',
          checkpoint: 'blob_transfer_started',
        },
      };
    },
  });

  if (latest.cancelRequestedAtMs || latest.status.status === 'aborted') {
    return latest;
  }

  const transferResult = await params.transferMissingBlobsToTargetCas({
    job: latest,
    offer,
    missingDigests: missingPlan.missingBlobs.map((blob) => blob.digest),
    missingBytes: missingPlan.plannedByteCount,
  }).catch(async (error: unknown) => {
    if (isCancelRequestedError(error)) {
      return await abortJobAndReturn({
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
      });
    }
    return await markJobFailedAndRethrow({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      error,
    });
  });

  if ('jobId' in transferResult) {
    // abortJobAndReturn returned a job record; stop execution immediately.
    return transferResult;
  }

  latest = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => {
      if (record.cancelRequestedAtMs) {
        return abortRecord(record, resolveNowMs(params.now));
      }
      return {
        ...record,
        status: {
          ...record.status,
          status: 'in_progress',
          phase: 'transfer_missing_blobs_to_target_cas',
          checkpoint: 'blob_transfer_completed',
          progressCounters: {
            ...record.status.progressCounters,
            transferredFiles: transferResult.transferredFiles,
            transferredBytes: transferResult.transferredBytes,
          },
        },
      };
    },
  });

  if (latest.cancelRequestedAtMs || latest.status.status === 'aborted') {
    return latest;
  }

  // 4) apply
  latest = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => {
      if (record.cancelRequestedAtMs) {
        return abortRecord(record, resolveNowMs(params.now));
      }
      return {
        ...record,
        status: {
          ...record.status,
          status: 'in_progress',
          phase: 'apply',
          checkpoint: 'apply_started',
        },
      };
    },
  });

  if (latest.cancelRequestedAtMs || latest.status.status === 'aborted') {
    return latest;
  }

  const applyResult = await params.applyPlan({
    job: latest,
    offer,
  }).catch(async (error: unknown) => {
    if (isCancelRequestedError(error)) {
      return await abortJobAndReturn({
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
      });
    }
    return await markJobFailedAndRethrow({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      error,
    });
  });

  if ('jobId' in applyResult) {
    return applyResult;
  }

  latest = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => {
      if (record.cancelRequestedAtMs) {
        return abortRecord(record, resolveNowMs(params.now));
      }
      return {
        ...record,
        status: {
          ...record.status,
          status: 'in_progress',
          phase: 'apply',
          checkpoint: 'apply_completed',
          progressCounters: {
            ...record.status.progressCounters,
            appliedFiles: applyResult.appliedFiles,
            appliedBytes: applyResult.appliedBytes,
          },
        },
      };
    },
  });

  if (latest.cancelRequestedAtMs || latest.status.status === 'aborted') {
    return latest;
  }

  // 5) commit baseline
  latest = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => {
      if (record.cancelRequestedAtMs) {
        return abortRecord(record, resolveNowMs(params.now));
      }
      return {
        ...record,
        status: {
          ...record.status,
          status: 'in_progress',
          phase: 'commit_baseline',
          checkpoint: 'apply_completed',
        },
      };
    },
  });

  await params.commitBaseline({
    job: latest,
    offer,
  }).catch(async (error: unknown) => {
    if (isCancelRequestedError(error)) {
      return await abortJobAndReturn({
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
      });
    }
    return await markJobFailedAndRethrow({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      error,
    });
  });

  // If commitBaseline threw cancellation, it was converted into an abort record update.
  const afterCommit = await params.jobStore.read(params.jobId);
  if (afterCommit?.status.status === 'aborted') {
    return afterCommit;
  }

  const completedAtMs = resolveNowMs(params.now);
  latest = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => ({
      ...record,
      completedAtMs,
      status: {
        ...record.status,
        status: 'completed',
        phase: 'commit_baseline',
        checkpoint: 'baseline_committed',
      },
    }),
  });

  return latest;
}
