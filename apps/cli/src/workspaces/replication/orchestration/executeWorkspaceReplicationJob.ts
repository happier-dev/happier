import { resolveWorkspaceReplicationJobStatusHeartbeatIntervalMs } from '@/configuration';

import type { WorkspaceReplicationRelationshipStore } from '../relationships/workspaceReplicationRelationshipStore';
import { planWorkspaceReplicationMissingBlobs } from '../transport/planWorkspaceReplicationMissingBlobs';
import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';
import { runWorkspaceReplicationJob } from '../jobs/runWorkspaceReplicationJob';
import type { WorkspaceReplicationJobRecord, WorkspaceReplicationJobStore } from '../jobs/workspaceReplicationJobStore';
import { WorkspaceReplicationError } from '../workspaceReplicationError';
import { WorkspaceReplicationJobCancelRequestedError } from '../safety/workspaceReplicationJobCancelRequestedError';
import {
  releaseWorkspaceReplicationJobLease,
  removeWorkspaceReplicationJobStagingDirectory,
  renewWorkspaceReplicationJobLease,
  resolveWorkspaceReplicationJobLeaseTtlMs,
  tryAcquireWorkspaceReplicationJobLease,
} from '../state/workspaceReplicationJobLease';
import { startWorkspaceReplicationJobLeaseHeartbeat } from '../state/workspaceReplicationJobLeaseHeartbeat';
import {
  releaseWorkspaceReplicationScopeLease,
  renewWorkspaceReplicationScopeLease,
  resolveWorkspaceReplicationScopeLeaseTtlMs,
  tryAcquireWorkspaceReplicationScopeLease,
} from '../state/workspaceReplicationScopeLease';
import { startWorkspaceReplicationScopeLeaseHeartbeat } from '../state/workspaceReplicationScopeLeaseHeartbeat';

const CHECKPOINT_ORDER: readonly WorkspaceReplicationJobRecord['status']['checkpoint'][] = [
  'job_created',
  'relationship_resolved',
  'missing_digests_negotiated',
  'blob_transfer_started',
  'blob_transfer_completed',
  'apply_started',
  'apply_completed',
  'baseline_committed',
] as const;

function isCheckpointAtOrAfter(
  current: WorkspaceReplicationJobRecord['status']['checkpoint'],
  required: WorkspaceReplicationJobRecord['status']['checkpoint'],
): boolean {
  return CHECKPOINT_ORDER.indexOf(current) >= CHECKPOINT_ORDER.indexOf(required);
}

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
  activeServerDir: string;
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
}>): Promise<WorkspaceReplicationJobRecord> {
  const nowMs = resolveNowMs(params.now);
  const record = await runWorkspaceReplicationJob({
    jobStore: params.jobStore,
    jobId: params.jobId,
    now: params.now,
    run: async (record) => abortRecord(record, nowMs),
  });
  await removeWorkspaceReplicationJobStagingDirectory({
    activeServerDir: params.activeServerDir,
    jobId: params.jobId,
  });
  return record;
}

async function abortIfCancellationRequested(params: Readonly<{
  activeServerDir: string;
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
}>): Promise<WorkspaceReplicationJobRecord | null> {
  const current = await params.jobStore.read(params.jobId);
  if (!current) {
    throw new WorkspaceReplicationError({
      code: 'job_not_found',
      message: `Workspace replication job not found: ${params.jobId}`,
    });
  }
  if (!current.cancelRequestedAtMs && current.status.status !== 'aborted') {
    return null;
  }
  return await abortJobAndReturn(params);
}

async function markJobFailedAndRethrow(params: Readonly<{
  activeServerDir: string;
  jobStore: WorkspaceReplicationJobStore;
  jobId: string;
  now?: () => number;
  error: unknown;
}>): Promise<never> {
  try {
    await runWorkspaceReplicationJob({
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
      run: async () => {
        throw params.error;
      },
    });
  } finally {
    await removeWorkspaceReplicationJobStagingDirectory({
      activeServerDir: params.activeServerDir,
      jobId: params.jobId,
    });
  }
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
  assertSafeToApply?: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
  }>) => Promise<
    | null
    | WorkspaceReplicationJobRecord
    | Readonly<{
        blockingDivergenceCandidates: readonly string[];
        lastErrorMessage?: string;
      }>
  >;
  transferMissingBlobsToTargetCas: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
    missingDigests: readonly string[];
    missingBytes: number;
  }>) => Promise<Readonly<{ transferredFiles: number; transferredBytes: number }>>;
  applyPlan: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
  }>) => Promise<Readonly<{ appliedFiles: number; appliedBytes: number; targetPath: string }>>;
  commitBaseline: (input: Readonly<{
    job: WorkspaceReplicationJobRecord;
    offer: WorkspaceReplicationSourceOffer;
  }>) => Promise<void>;
}>): Promise<WorkspaceReplicationJobRecord> {
  let current = await params.jobStore.read(params.jobId);
  if (!current) {
    throw new WorkspaceReplicationError({
      code: 'job_not_found',
      message: `Workspace replication job not found: ${params.jobId}`,
    });
  }

  if (current.status.status === 'completed' || current.status.status === 'failed' || current.status.status === 'awaiting_recovery') {
    return current;
  }

  const leaseOwnerId = `cli-daemon:${process.pid}`;
  const leaseTtlMs = resolveWorkspaceReplicationJobLeaseTtlMs();
  const leaseAttempt = await tryAcquireWorkspaceReplicationJobLease({
    activeServerDir: params.activeServerDir,
    jobId: params.jobId,
    ownerId: leaseOwnerId,
    nowMs: resolveNowMs(params.now),
    ttlMs: leaseTtlMs,
  });
  if (!leaseAttempt.acquired) {
    const latest = await params.jobStore.read(params.jobId);
    return latest ?? current;
  }

  const heartbeat = startWorkspaceReplicationJobLeaseHeartbeat({
    activeServerDir: params.activeServerDir,
    jobId: params.jobId,
    ownerId: leaseOwnerId,
    ttlMs: leaseTtlMs,
    nowMs: () => resolveNowMs(params.now),
  });

  {
    // Persist durable attempt metadata as soon as we acquire the job lease so that even
    // early exits (scope lock, cancellation, etc.) record which runner/attempt touched the job.
    const acquiredLease = leaseAttempt.lease;
    if (acquiredLease?.attempt && acquiredLease.leaseId) {
      current = await runWorkspaceReplicationJob({
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        run: async (record) => ({
          ...record,
          lastAttempt: {
            attemptNumber: acquiredLease.attempt ?? 1,
            leaseId: acquiredLease.leaseId ?? 'unknown',
            ownerId: leaseOwnerId,
            acquiredAtMs: acquiredLease.acquiredAtMs,
          },
        }),
      });
    }
  }

  const scopeRelationshipId = current.relationshipId;
  const scopeDirectionId = current.directionId;
  if (!scopeRelationshipId || !scopeDirectionId) {
    throw new Error(`Workspace replication job is missing relationship scope: ${params.jobId}`);
  }

  const scopeLeaseOwnerId = `${leaseOwnerId}:${params.jobId}`;
  const scopeLeaseTtlMs = resolveWorkspaceReplicationScopeLeaseTtlMs();
  let scopeLeaseAcquired = false;
  let scopeLeaseHeartbeat: Readonly<{ stop: () => Promise<void> }> | null = null;

  const stopIfLeaseLost = async (): Promise<WorkspaceReplicationJobRecord | null> => {
    const nowMs = resolveNowMs(params.now);
    let renewed: Awaited<ReturnType<typeof renewWorkspaceReplicationJobLease>>;
    try {
      renewed = await renewWorkspaceReplicationJobLease({
        activeServerDir: params.activeServerDir,
        jobId: params.jobId,
        ownerId: leaseOwnerId,
        nowMs,
        ttlMs: leaseTtlMs,
      });
    } catch (error) {
      return await markJobFailedAndRethrow({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        error,
      });
    }

    if (renewed.renewed) {
      return null;
    }

    const latest = await params.jobStore.read(params.jobId);
    if (!latest) {
      throw new WorkspaceReplicationError({
        code: 'job_not_found',
        message: `Workspace replication job not found: ${params.jobId}`,
      });
    }
    return latest;
  };

  const stopIfScopeLeaseLost = async (): Promise<WorkspaceReplicationJobRecord | null> => {
    if (!scopeLeaseAcquired) {
      return null;
    }

    const nowMs = resolveNowMs(params.now);
    let renewed: Awaited<ReturnType<typeof renewWorkspaceReplicationScopeLease>>;
    try {
      renewed = await renewWorkspaceReplicationScopeLease({
        activeServerDir: params.activeServerDir,
        relationshipId: scopeRelationshipId,
        directionId: scopeDirectionId,
        ownerId: scopeLeaseOwnerId,
        nowMs,
        ttlMs: scopeLeaseTtlMs,
      });
    } catch (error) {
      return await markJobFailedAndRethrow({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        error,
      });
    }

    if (renewed.renewed) {
      return null;
    }

    const latest = await params.jobStore.read(params.jobId);
    if (!latest) {
      throw new WorkspaceReplicationError({
        code: 'job_not_found',
        message: `Workspace replication job not found: ${params.jobId}`,
      });
    }
    return latest;
  };

  try {
    // Cancellation is higher priority than scope locking. If a job is already canceled (or already
    // aborted), abort and clean up staging without attempting to acquire the scope lease.
    const cancelledBeforeScopeLease = await abortIfCancellationRequested({
      activeServerDir: params.activeServerDir,
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
    });
    if (cancelledBeforeScopeLease) {
      return cancelledBeforeScopeLease;
    }

    const scopeLeaseAttempt = await tryAcquireWorkspaceReplicationScopeLease({
      activeServerDir: params.activeServerDir,
      relationshipId: scopeRelationshipId,
      directionId: scopeDirectionId,
      ownerId: scopeLeaseOwnerId,
      nowMs: resolveNowMs(params.now),
      ttlMs: scopeLeaseTtlMs,
    });

    if (!scopeLeaseAttempt.acquired) {
      const cancelledWhileScopeLocked = await abortIfCancellationRequested({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
      });
      if (cancelledWhileScopeLocked) {
        return cancelledWhileScopeLocked;
      }

      const nowMs = resolveNowMs(params.now);
      const updated = await runWorkspaceReplicationJob({
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        run: async (record) => ({
          ...record,
          awaitingRecoveryAtMs: record.awaitingRecoveryAtMs ?? nowMs,
          lastErrorMessage: record.lastErrorMessage ?? 'Workspace replication scope is locked by another job',
          status: {
            ...record.status,
            status: 'awaiting_recovery',
            phase: 'planning',
            checkpoint: record.status.checkpoint,
          },
        }),
      });
      await removeWorkspaceReplicationJobStagingDirectory({
        activeServerDir: params.activeServerDir,
        jobId: params.jobId,
      });
      return updated;
    }

    scopeLeaseAcquired = true;
    scopeLeaseHeartbeat = startWorkspaceReplicationScopeLeaseHeartbeat({
      activeServerDir: params.activeServerDir,
      relationshipId: scopeRelationshipId,
      directionId: scopeDirectionId,
      ownerId: scopeLeaseOwnerId,
      ttlMs: scopeLeaseTtlMs,
      nowMs: () => resolveNowMs(params.now),
    });

    if (leaseAttempt.lease?.attempt && leaseAttempt.lease.attempt > 1) {
      await runWorkspaceReplicationJob({
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        run: async (record) => ({
          ...record,
          status: {
            ...record.status,
            warnings: record.status.warnings.includes('resumed_existing_job')
              ? record.status.warnings
              : [...record.status.warnings, 'resumed_existing_job'],
          },
        }),
      });
      current = await params.jobStore.read(params.jobId);
      if (!current) {
        throw new WorkspaceReplicationError({
          code: 'job_not_found',
          message: `Workspace replication job not found: ${params.jobId}`,
        });
      }
    }

    if (current.cancelRequestedAtMs || current.status.status === 'aborted') {
      const nowMs = resolveNowMs(params.now);
      const aborted = await runWorkspaceReplicationJob({
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        run: async (record) => abortRecord(record, nowMs),
      });
      await removeWorkspaceReplicationJobStagingDirectory({
        activeServerDir: params.activeServerDir,
        jobId: params.jobId,
      });
      return aborted;
    }

    if (!current.relationshipId) {
      return await markJobFailedAndRethrow({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        error: new Error(`Workspace replication job is missing relationshipId: ${current.jobId}`),
      });
    }
    if (!current.offerId) {
      return await markJobFailedAndRethrow({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        error: new Error(`Workspace replication job is missing offerId: ${current.jobId}`),
      });
    }

    let relationship: Awaited<ReturnType<typeof params.relationships.read>>;
    try {
      relationship = await params.relationships.read(current.relationshipId);
    } catch (error) {
      return await markJobFailedAndRethrow({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        error,
      });
    }

    if (!relationship) {
      return await markJobFailedAndRethrow({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        error: new Error(`Workspace replication relationship not found: ${current.relationshipId}`),
      });
    }

    let offer: WorkspaceReplicationSourceOffer;
    try {
      offer = await params.resolveSourceOfferById(current.offerId);
    } catch (error) {
      return await markJobFailedAndRethrow({
        activeServerDir: params.activeServerDir,
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        error,
      });
    }

    const runSafetyCheckIfNeeded = async (job: WorkspaceReplicationJobRecord): Promise<WorkspaceReplicationJobRecord | null> => {
      if (!params.assertSafeToApply) {
        return null;
      }

      const safeCheck = await params.assertSafeToApply({
        job,
        offer,
      }).catch(async (error: unknown) => {
        if (isCancelRequestedError(error)) {
          return await abortJobAndReturn({
            activeServerDir: params.activeServerDir,
            jobStore: params.jobStore,
            jobId: params.jobId,
            now: params.now,
          });
        }
        const cancelled = await abortIfCancellationRequested({
          activeServerDir: params.activeServerDir,
          jobStore: params.jobStore,
          jobId: params.jobId,
          now: params.now,
        });
        if (cancelled) {
          return cancelled;
        }
        return await markJobFailedAndRethrow({
          activeServerDir: params.activeServerDir,
          jobStore: params.jobStore,
          jobId: params.jobId,
          now: params.now,
          error,
        });
      });

      if (safeCheck && 'jobId' in safeCheck) {
        return safeCheck;
      }

      if (safeCheck && safeCheck.blockingDivergenceCandidates.length > 0) {
        const nowMs = resolveNowMs(params.now);
        const updated = await runWorkspaceReplicationJob({
          jobStore: params.jobStore,
          jobId: params.jobId,
          now: params.now,
          run: async (record) => ({
            ...record,
            awaitingRecoveryAtMs: record.awaitingRecoveryAtMs ?? nowMs,
            lastErrorMessage: safeCheck.lastErrorMessage ?? record.lastErrorMessage ?? 'Target workspace diverged since last baseline',
            status: {
              ...record.status,
              status: 'awaiting_recovery',
              phase: 'planning',
              checkpoint: record.status.checkpoint,
              blockingDivergenceCandidates: [...safeCheck.blockingDivergenceCandidates],
            },
          }),
        });
        await removeWorkspaceReplicationJobStagingDirectory({
          activeServerDir: params.activeServerDir,
          jobId: params.jobId,
        });
        return updated;
      }

      return null;
    };

    // 1) relationship resolved
    let latest: WorkspaceReplicationJobRecord = current;
    if (!isCheckpointAtOrAfter(latest.status.checkpoint, 'relationship_resolved')) {
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
    }

    const cancelledAfterRelationshipResolved = await abortIfCancellationRequested({
      activeServerDir: params.activeServerDir,
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
    });
    if (cancelledAfterRelationshipResolved) {
      return cancelledAfterRelationshipResolved;
    }

  // 1.5) one-way-safe divergence gating (fail closed)
  {
    const safeCheckResult = await runSafetyCheckIfNeeded(latest);
    if (safeCheckResult) {
      return safeCheckResult;
    }
  }

  if (!isCheckpointAtOrAfter(latest.status.checkpoint, 'blob_transfer_completed')) {
    // 2) missing digests negotiated (local CAS contains check)
    const missingPlan = await planWorkspaceReplicationMissingBlobs({
      activeServerDir: params.activeServerDir,
      blobIndex: offer.blobIndex,
    });

    if (!isCheckpointAtOrAfter(latest.status.checkpoint, 'missing_digests_negotiated')) {
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
    }

    const cancelledAfterMissingDigestsNegotiated = await abortIfCancellationRequested({
      activeServerDir: params.activeServerDir,
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
    });
    if (cancelledAfterMissingDigestsNegotiated) {
      return cancelledAfterMissingDigestsNegotiated;
    }

    // 3) transfer missing blobs into target CAS
    if (!isCheckpointAtOrAfter(latest.status.checkpoint, 'blob_transfer_started')) {
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
    }

    const cancelledBeforeTransfer = await abortIfCancellationRequested({
      activeServerDir: params.activeServerDir,
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
    });
    if (cancelledBeforeTransfer) {
      return cancelledBeforeTransfer;
    }

	    const transferResult = await params.transferMissingBlobsToTargetCas({
	      job: latest,
	      offer,
	      missingDigests: missingPlan.missingBlobs.map((blob) => blob.digest),
	      missingBytes: missingPlan.plannedByteCount,
	    }).catch(async (error: unknown) => {
	      if (isCancelRequestedError(error)) {
	        return await abortJobAndReturn({
	          activeServerDir: params.activeServerDir,
	          jobStore: params.jobStore,
	          jobId: params.jobId,
	          now: params.now,
	        });
	      }
	      const cancelled = await abortIfCancellationRequested({
	        activeServerDir: params.activeServerDir,
	        jobStore: params.jobStore,
	        jobId: params.jobId,
	        now: params.now,
	      });
	      if (cancelled) {
	        return cancelled;
	      }
	      return await markJobFailedAndRethrow({
	        activeServerDir: params.activeServerDir,
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

    const lostLeaseAfterTransfer = await stopIfLeaseLost();
    if (lostLeaseAfterTransfer) {
      return lostLeaseAfterTransfer;
    }

    const lostScopeLeaseAfterTransfer = await stopIfScopeLeaseLost();
    if (lostScopeLeaseAfterTransfer) {
      return lostScopeLeaseAfterTransfer;
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

    const cancelledAfterTransferCompleted = await abortIfCancellationRequested({
      activeServerDir: params.activeServerDir,
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
    });
    if (cancelledAfterTransferCompleted) {
      return cancelledAfterTransferCompleted;
    }
  }

  if (!isCheckpointAtOrAfter(latest.status.checkpoint, 'apply_completed')) {
    const lostLeaseBeforeApply = await stopIfLeaseLost();
    if (lostLeaseBeforeApply) {
      return lostLeaseBeforeApply;
    }

    const lostScopeLeaseBeforeApply = await stopIfScopeLeaseLost();
    if (lostScopeLeaseBeforeApply) {
      return lostScopeLeaseBeforeApply;
    }

    // 3.5) one-way-safe divergence gating (fail closed) again after blob transfer completes.
    // This ensures mid-transfer edits on the target workspace can't be overwritten by a stale
    // pre-transfer safety check.
    if (
      params.assertSafeToApply
      && isCheckpointAtOrAfter(latest.status.checkpoint, 'blob_transfer_completed')
      && !isCheckpointAtOrAfter(latest.status.checkpoint, 'apply_started')
    ) {
      const safeCheckResult = await runSafetyCheckIfNeeded(latest);
      if (safeCheckResult) {
        return safeCheckResult;
      }
    }

    // 4) apply
    if (!isCheckpointAtOrAfter(latest.status.checkpoint, 'apply_started')) {
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
    }

    const cancelledBeforeApply = await abortIfCancellationRequested({
      activeServerDir: params.activeServerDir,
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
    });
    if (cancelledBeforeApply) {
      return cancelledBeforeApply;
    }

    const statusHeartbeatIntervalMs = resolveWorkspaceReplicationJobStatusHeartbeatIntervalMs();
    let statusHeartbeatStopped = false;
    const statusHeartbeatState: { inFlight: Promise<void> | null } = { inFlight: null };
    const probeStatusHeartbeatOnce = async (): Promise<void> => {
      if (statusHeartbeatStopped) return;
      if (statusHeartbeatState.inFlight) {
        try {
          await statusHeartbeatState.inFlight;
        } catch {
          // ignore
        }
        return;
      }
      statusHeartbeatState.inFlight = runWorkspaceReplicationJob({
        jobStore: params.jobStore,
        jobId: params.jobId,
        now: params.now,
        run: async (record) => record,
      })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          statusHeartbeatState.inFlight = null;
        });
      try {
        await statusHeartbeatState.inFlight;
      } catch {
        // ignore
      }
    };

    const statusHeartbeatHandle = setInterval(probeStatusHeartbeatOnce, statusHeartbeatIntervalMs);
    statusHeartbeatHandle.unref?.();

    let applyResult: Awaited<ReturnType<typeof params.applyPlan>> | WorkspaceReplicationJobRecord;
    try {
      applyResult = await params.applyPlan({
        job: latest,
        offer,
      }).catch(async (error: unknown) => {
        if (isCancelRequestedError(error)) {
          return await abortJobAndReturn({
            activeServerDir: params.activeServerDir,
            jobStore: params.jobStore,
            jobId: params.jobId,
            now: params.now,
          });
        }
        const cancelled = await abortIfCancellationRequested({
          activeServerDir: params.activeServerDir,
          jobStore: params.jobStore,
          jobId: params.jobId,
          now: params.now,
        });
        if (cancelled) {
          return cancelled;
        }
        return await markJobFailedAndRethrow({
          activeServerDir: params.activeServerDir,
          jobStore: params.jobStore,
          jobId: params.jobId,
          now: params.now,
	        error,
	      });
	    });
    } finally {
      statusHeartbeatStopped = true;
      clearInterval(statusHeartbeatHandle);
      if (statusHeartbeatState.inFlight) {
        try {
          await statusHeartbeatState.inFlight;
        } catch {
          // ignore
        }
      }
    }

    if ('jobId' in applyResult) {
      return applyResult;
    }

    const lostLeaseAfterApply = await stopIfLeaseLost();
    if (lostLeaseAfterApply) {
      return lostLeaseAfterApply;
    }

    const lostScopeLeaseAfterApply = await stopIfScopeLeaseLost();
    if (lostScopeLeaseAfterApply) {
      return lostScopeLeaseAfterApply;
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
          result: {
            targetPath: applyResult.targetPath,
          },
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

    const cancelledAfterApplyCompleted = await abortIfCancellationRequested({
      activeServerDir: params.activeServerDir,
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
    });
    if (cancelledAfterApplyCompleted) {
      return cancelledAfterApplyCompleted;
    }
  }

  if (!isCheckpointAtOrAfter(latest.status.checkpoint, 'baseline_committed')) {
    const lostLeaseBeforeBaselineCommit = await stopIfLeaseLost();
    if (lostLeaseBeforeBaselineCommit) {
      return lostLeaseBeforeBaselineCommit;
    }

    const lostScopeLeaseBeforeBaselineCommit = await stopIfScopeLeaseLost();
    if (lostScopeLeaseBeforeBaselineCommit) {
      return lostScopeLeaseBeforeBaselineCommit;
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
            checkpoint: record.status.checkpoint,
          },
        };
      },
    });

    const cancelledBeforeBaselineCommit = await abortIfCancellationRequested({
      activeServerDir: params.activeServerDir,
      jobStore: params.jobStore,
      jobId: params.jobId,
      now: params.now,
    });
    if (cancelledBeforeBaselineCommit) {
      return cancelledBeforeBaselineCommit;
    }

	    await params.commitBaseline({
	      job: latest,
	      offer,
	    }).catch(async (error: unknown) => {
	      if (isCancelRequestedError(error)) {
	        return await abortJobAndReturn({
	          activeServerDir: params.activeServerDir,
	          jobStore: params.jobStore,
	          jobId: params.jobId,
	          now: params.now,
	        });
	      }
	      const cancelled = await abortIfCancellationRequested({
	        activeServerDir: params.activeServerDir,
	        jobStore: params.jobStore,
	        jobId: params.jobId,
	        now: params.now,
	      });
	      if (cancelled) {
	        return;
	      }
	      return await markJobFailedAndRethrow({
	        activeServerDir: params.activeServerDir,
	        jobStore: params.jobStore,
	        jobId: params.jobId,
	        now: params.now,
	        error,
	      });
	    });

    // If commitBaseline threw cancellation, it was converted into an abort record update.
    const afterCommit = await params.jobStore.read(params.jobId);
    if (afterCommit?.status.status === 'aborted') {
      await removeWorkspaceReplicationJobStagingDirectory({
        activeServerDir: params.activeServerDir,
        jobId: params.jobId,
      });
      return afterCommit;
    }

    const lostLeaseAfterCommit = await stopIfLeaseLost();
    if (lostLeaseAfterCommit) {
      return lostLeaseAfterCommit;
    }

    const lostScopeLeaseAfterCommit = await stopIfScopeLeaseLost();
    if (lostScopeLeaseAfterCommit) {
      return lostScopeLeaseAfterCommit;
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

    await removeWorkspaceReplicationJobStagingDirectory({
      activeServerDir: params.activeServerDir,
      jobId: params.jobId,
    });
  }

    return latest;
  } finally {
    await scopeLeaseHeartbeat?.stop().catch(() => undefined);
    if (scopeLeaseAcquired) {
      await releaseWorkspaceReplicationScopeLease({
        activeServerDir: params.activeServerDir,
        relationshipId: scopeRelationshipId,
        directionId: scopeDirectionId,
        ownerId: scopeLeaseOwnerId,
      }).catch(() => undefined);
    }
    await heartbeat.stop().catch(() => undefined);
    await releaseWorkspaceReplicationJobLease({
      activeServerDir: params.activeServerDir,
      jobId: params.jobId,
      ownerId: leaseOwnerId,
    }).catch(() => undefined);
  }
}
