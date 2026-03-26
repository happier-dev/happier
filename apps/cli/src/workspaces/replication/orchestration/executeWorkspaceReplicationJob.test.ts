import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';

describe('executeWorkspaceReplicationJob', () => {
  it('heartbeats job updatedAtMs while apply is running so long apply phases stay observable', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-apply-heartbeat-'));
    const previous = process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_STATUS_HEARTBEAT_INTERVAL_MS;
    process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_STATUS_HEARTBEAT_INTERVAL_MS = '1000';
    vi.useFakeTimers();

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const scope = {
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      };
      const relationship = await relationships.ensureRelationship(scope);

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_apply_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_apply_1',
        sourceFingerprint: 'fp_apply_1',
        manifest: { entries: [], fingerprint: 'fp_apply_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_apply_1',
        relationshipId: relationship.relationshipId,
        directionId: offer.directionId,
        offerId: offer.offerId,
        mode: 'one_way_safe',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const createDeferred = <T,>() => {
        let resolve!: (value: T) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      };

      const applyDeferred = createDeferred<Readonly<{ appliedFiles: number; appliedBytes: number; targetPath: string }>>();

      const applyEntered = createDeferred<void>();

      let applyStartedUpdatedAtMs = 0;
      const applyPlan = vi.fn(async (input: any) => {
        applyEntered.resolve();
        applyStartedUpdatedAtMs = typeof input?.job?.updatedAtMs === 'number' ? input.job.updatedAtMs : 0;
        return await applyDeferred.promise;
      });

      const runPromise = executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_apply_1',
        now: () => Date.now(),
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas: async () => ({ transferredFiles: 0, transferredBytes: 0 }),
        applyPlan,
        commitBaseline: async () => undefined,
      });

      await applyEntered.promise;
      expect(applyPlan).toHaveBeenCalledTimes(1);
      expect(applyStartedUpdatedAtMs).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(3_000);
      let midApplyUpdatedAtMs = 0;
      for (let i = 0; i < 50; i += 1) {
        const midApply = await jobStore.read('job_apply_1');
        midApplyUpdatedAtMs = midApply?.updatedAtMs ?? 0;
        if (midApplyUpdatedAtMs > applyStartedUpdatedAtMs) {
          break;
        }
        // Allow the interval callback + fs writes to run.
        await Promise.resolve();
      }
      expect(midApplyUpdatedAtMs).toBeGreaterThan(applyStartedUpdatedAtMs);

      applyDeferred.resolve({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' });
      const result = await runPromise;
      expect(result.status.status).toBe('completed');
    } finally {
      vi.useRealTimers();
      if (previous === undefined) {
        delete process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_STATUS_HEARTBEAT_INTERVAL_MS;
      } else {
        process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_STATUS_HEARTBEAT_INTERVAL_MS = previous;
      }
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed and does not call handlers when the replication scope lease is held', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-scope-lease-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { tryAcquireWorkspaceReplicationScopeLease } = await import('../state/workspaceReplicationScopeLease');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const scope = {
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      };
      const relationship = await relationships.ensureRelationship(scope);

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_scope_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const held = await tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        ownerId: 'other-owner',
        nowMs: 1,
        ttlMs: 60_000,
      });
      expect(held.acquired).toBe(true);

      const transferMissingBlobsToTargetCas = vi.fn();
      const applyPlan = vi.fn();
      const commitBaseline = vi.fn();

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_scope_1',
        now: () => 2,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(result.status.status).toBe('awaiting_recovery');
      expect(result.lastErrorMessage).toMatch(/scope/i);
      expect(result.lastAttempt).toMatchObject({
        attemptNumber: 1,
        acquiredAtMs: 2,
      });
      expect(typeof result.lastAttempt?.leaseId).toBe('string');
      expect(result.lastAttempt?.leaseId.length).toBeGreaterThan(0);
      expect(result.lastAttempt?.ownerId).toMatch(/^cli-daemon:/u);
      expect(transferMissingBlobsToTargetCas).not.toHaveBeenCalled();
      expect(applyPlan).not.toHaveBeenCalled();
      expect(commitBaseline).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('aborts (does not enter awaiting_recovery) when cancellation is requested while the replication scope lease is held', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-scope-lease-cancel-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { tryAcquireWorkspaceReplicationScopeLease } = await import('../state/workspaceReplicationScopeLease');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_scope_cancel_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        createdAtMs: 10,
        updatedAtMs: 10,
        cancelRequestedAtMs: 5,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const held = await tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        ownerId: 'other-owner',
        nowMs: 1,
        ttlMs: 60_000,
      });
      expect(held.acquired).toBe(true);

      const transferMissingBlobsToTargetCas = vi.fn();
      const applyPlan = vi.fn();
      const commitBaseline = vi.fn();

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_scope_cancel_1',
        now: () => 6,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(result.status.status).toBe('aborted');
      expect(result.cancelRequestedAtMs).toBe(5);
      expect(result.abortedAtMs).toBe(6);
      expect(transferMissingBlobsToTargetCas).not.toHaveBeenCalled();
      expect(applyPlan).not.toHaveBeenCalled();
      expect(commitBaseline).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('runs the job through checkpoints and persists a completed status', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const scope = {
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      };
      const relationship = await relationships.ensureRelationship(scope);

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
              digest: 'sha256:deadbeef',
              sizeBytes: 10,
              executable: false,
            },
          ],
          fingerprint: 'fp_1',
        },
        blobIndex: [{ digest: 'sha256:deadbeef', sizeBytes: 10 }],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'negotiate_missing_digests',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const now = vi.fn(() => 42);
      const transferMissingBlobsToTargetCas = vi.fn(async () => ({
        transferredFiles: 1,
        transferredBytes: 10,
      }));
      const applyPlan = vi.fn(async () => ({
        appliedFiles: 1,
        appliedBytes: 10,
        targetPath: '/target-applied',
      }));
      const commitBaseline = vi.fn(async () => undefined);

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_1',
        now,
        resolveSourceOfferById: async (offerId) => {
          expect(offerId).toBe('offer_1');
          return offer;
        },
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(transferMissingBlobsToTargetCas).toHaveBeenCalledTimes(1);
      expect(applyPlan).toHaveBeenCalledTimes(1);
      expect(commitBaseline).toHaveBeenCalledTimes(1);

      expect(result.status).toMatchObject({
        status: 'completed',
        phase: 'commit_baseline',
        checkpoint: 'baseline_committed',
        progressCounters: {
          plannedFiles: 1,
          plannedBytes: 10,
          transferredFiles: 1,
          transferredBytes: 10,
          appliedFiles: 1,
          appliedBytes: 10,
        },
      });
      expect(result.completedAtMs).toBe(42);

      await expect(jobStore.read('job_1')).resolves.toMatchObject({
        jobId: 'job_1',
        completedAtMs: 42,
        result: {
          targetPath: '/target-applied',
        },
        status: {
          status: 'completed',
          checkpoint: 'baseline_committed',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

	  it('fails closed and does not call handlers when cancel is requested', async () => {
	    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-cancel-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_cancel_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: 'offer_1',
        mode: 'one_way_safe',
        correlationId: 'corr_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        cancelRequestedAtMs: 11,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const transferMissingBlobsToTargetCas = vi.fn();
      const applyPlan = vi.fn();
      const commitBaseline = vi.fn();

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_cancel_1',
        now: () => 99,
        resolveSourceOfferById: async () => {
          throw new Error('should not be called');
        },
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(result.status.status).toBe('aborted');
      expect(transferMissingBlobsToTargetCas).not.toHaveBeenCalled();
      expect(applyPlan).not.toHaveBeenCalled();
      expect(commitBaseline).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when lease renewal throws during orchestration checkpoints', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-lease-renew-failure-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');

      vi.resetModules();
      vi.doMock('../state/workspaceReplicationJobLease', async () => {
        const actual = await vi.importActual<typeof import('../state/workspaceReplicationJobLease')>(
          '../state/workspaceReplicationJobLease',
        );
        return {
          ...actual,
          renewWorkspaceReplicationJobLease: vi.fn(async () => {
            throw new Error('lease renewal write failed');
          }),
        };
      });

      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_renew_failure',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: {
          entries: [],
          fingerprint: 'fp_1',
        },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_renew_failure_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'negotiate_missing_digests',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const transferMissingBlobsToTargetCas = vi.fn(async () => ({
        transferredFiles: 0,
        transferredBytes: 0,
      }));
      const applyPlan = vi.fn(async () => ({
        appliedFiles: 0,
        appliedBytes: 0,
        targetPath: '/target-applied',
      }));
      const commitBaseline = vi.fn(async () => undefined);

      await expect(
        executeWorkspaceReplicationJob({
          activeServerDir,
          jobStore,
          relationships,
          jobId: 'job_renew_failure_1',
          now: () => 42,
          resolveSourceOfferById: async () => offer,
          transferMissingBlobsToTargetCas,
          applyPlan,
          commitBaseline,
        }),
      ).rejects.toThrow('lease renewal write failed');

      expect(transferMissingBlobsToTargetCas).toHaveBeenCalledTimes(1);
      expect(applyPlan).not.toHaveBeenCalled();
      expect(commitBaseline).not.toHaveBeenCalled();

      await expect(jobStore.read('job_renew_failure_1')).resolves.toMatchObject({
        jobId: 'job_renew_failure_1',
        status: {
          status: 'failed',
        },
        lastErrorMessage: 'lease renewal write failed',
      });
    } finally {
      vi.doUnmock('../state/workspaceReplicationJobLease');
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('hard-stops before blob transfer when cancellation is requested after blob_transfer_started is persisted', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-cancel-mid-transfer-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const rawJobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [{ digest: 'sha256:deadbeef', sizeBytes: 10 }],
      };

      await rawJobStore.write({
        schemaVersion: 1,
        jobId: 'job_cancel_mid_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const jobStore = {
        ...rawJobStore,
        write: async (record: any) => {
          await rawJobStore.write(record);
          if (record.jobId === 'job_cancel_mid_1' && record.status?.checkpoint === 'blob_transfer_started') {
            await rawJobStore.update('job_cancel_mid_1', (current: any) => ({
              ...current,
              cancelRequestedAtMs: 55,
            }));
          }
        },
      } as any;

      const transferMissingBlobsToTargetCas = vi.fn(async () => ({
        transferredFiles: 1,
        transferredBytes: 10,
      }));
      const applyPlan = vi.fn();
      const commitBaseline = vi.fn();

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_cancel_mid_1',
        now: () => 99,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(result.status.status).toBe('aborted');
      expect(transferMissingBlobsToTargetCas).not.toHaveBeenCalled();
      expect(applyPlan).not.toHaveBeenCalled();
      expect(commitBaseline).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('aborts (not fails) when cancellation is requested while the blob transfer handler throws', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-cancel-vs-fail-transfer-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { abortWorkspaceReplicationJob } = await import('../jobs/abortWorkspaceReplicationJob');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_cancel_vs_fail_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [{ digest: 'sha256:deadbeef', sizeBytes: 10 }],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_cancel_vs_fail_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_cancel_vs_fail_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_cancel_vs_fail_1',
        now: () => 60,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas: async () => {
          await abortWorkspaceReplicationJob({
            jobStore,
            jobId: 'job_cancel_vs_fail_1',
            now: () => 50,
          });
          throw new Error('boom');
        },
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }),
        commitBaseline: async () => undefined,
      });

      expect(result.status.status).toBe('aborted');
      await expect(jobStore.read('job_cancel_vs_fail_1')).resolves.toMatchObject({
        cancelRequestedAtMs: 50,
        status: { status: 'aborted' },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('hard-stops before apply when cancellation is requested after apply_started is persisted', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-cancel-mid-apply-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const rawJobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await rawJobStore.write({
        schemaVersion: 1,
        jobId: 'job_cancel_mid_2',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const jobStore = {
        ...rawJobStore,
        write: async (record: any) => {
          await rawJobStore.write(record);
          if (record.jobId === 'job_cancel_mid_2' && record.status?.checkpoint === 'apply_started') {
            await rawJobStore.update('job_cancel_mid_2', (current: any) => ({
              ...current,
              cancelRequestedAtMs: 66,
            }));
          }
        },
      } as any;

      const transferMissingBlobsToTargetCas = vi.fn(async () => ({
        transferredFiles: 0,
        transferredBytes: 0,
      }));
      const applyPlan = vi.fn(async () => ({
        appliedFiles: 0,
        appliedBytes: 0,
        targetPath: '/target-applied',
      }));
      const commitBaseline = vi.fn();

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_cancel_mid_2',
        now: () => 99,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(result.status.status).toBe('aborted');
      expect(applyPlan).not.toHaveBeenCalled();
      expect(commitBaseline).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('hard-stops before baseline commit when cancellation is requested after commit_baseline phase is persisted', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-cancel-mid-baseline-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const rawJobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await rawJobStore.write({
        schemaVersion: 1,
        jobId: 'job_cancel_mid_3',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const jobStore = {
        ...rawJobStore,
        write: async (record: any) => {
          await rawJobStore.write(record);
          if (record.jobId === 'job_cancel_mid_3' && record.status?.phase === 'commit_baseline') {
            await rawJobStore.update('job_cancel_mid_3', (current: any) => ({
              ...current,
              cancelRequestedAtMs: 77,
            }));
          }
        },
      } as any;

      const transferMissingBlobsToTargetCas = vi.fn(async () => ({
        transferredFiles: 0,
        transferredBytes: 0,
      }));
      const applyPlan = vi.fn(async () => ({
        appliedFiles: 0,
        appliedBytes: 0,
        targetPath: '/target-applied',
      }));
      const commitBaseline = vi.fn(async () => undefined);

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_cancel_mid_3',
        now: () => 99,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(result.status.status).toBe('aborted');
      expect(commitBaseline).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when another runner holds the job lease (does not perform transfer/apply mutations)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-lease-held-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { tryAcquireWorkspaceReplicationJobLease } = await import('../state/workspaceReplicationJobLease');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_lease_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_lease_held_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_lease_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_held_1',
        ownerId: 'other-runner',
        nowMs: 1000,
        ttlMs: 60_000,
      });
      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_held_1',
        ownerId: 'sanity-runner',
        nowMs: 2000,
        ttlMs: 60_000,
      })).resolves.toMatchObject({ acquired: false });

      const transferMissingBlobsToTargetCas = vi.fn(async () => ({ transferredFiles: 0, transferredBytes: 0 }));
      const applyPlan = vi.fn(async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }));

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_lease_held_1',
        now: () => 2000,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline: async () => undefined,
      });

      expect(transferMissingBlobsToTargetCas).not.toHaveBeenCalled();
      expect(applyPlan).not.toHaveBeenCalled();
      expect(result.jobId).toBe('job_lease_held_1');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('hard-stops and does not call apply when the lease is stolen mid-transfer (lost lease is fail-closed)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-lease-stolen-'));

    const previousLeaseTtl = process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS;
    process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS = '5000';

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { tryAcquireWorkspaceReplicationJobLease } = await import('../state/workspaceReplicationJobLease');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_lease_stolen_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [{ digest: 'sha256:deadbeef', sizeBytes: 10 }],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_lease_stolen_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_lease_stolen_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const transferMissingBlobsToTargetCas = vi.fn(async () => {
        // Lease is held by the current process, but it expires; simulate another runner stealing it mid-flight.
        await tryAcquireWorkspaceReplicationJobLease({
          activeServerDir,
          jobId: 'job_lease_stolen_1',
          ownerId: 'other-runner',
          nowMs: 7001,
          ttlMs: 60_000,
        });
        return { transferredFiles: 1, transferredBytes: 10 };
      });

      const applyPlan = vi.fn(async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }));
      const commitBaseline = vi.fn(async () => undefined);

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_lease_stolen_1',
        now: () => 1000,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(transferMissingBlobsToTargetCas).toHaveBeenCalledTimes(1);
      expect(applyPlan).not.toHaveBeenCalled();
      expect(commitBaseline).not.toHaveBeenCalled();
      expect(result.status.checkpoint).not.toBe('apply_started');
      expect(result.status.checkpoint).not.toBe('apply_completed');
      expect(result.status.checkpoint).not.toBe('baseline_committed');
    } finally {
      if (previousLeaseTtl === undefined) {
        delete process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS;
      } else {
        process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS = previousLeaseTtl;
      }
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('hard-stops and does not call apply when the scope lease is stolen mid-transfer (lost scope lease is fail-closed)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-scope-lease-stolen-'));

    const previousScopeLeaseTtl = process.env.HAPPIER_WORKSPACE_REPLICATION_SCOPE_LEASE_TTL_MS;
    process.env.HAPPIER_WORKSPACE_REPLICATION_SCOPE_LEASE_TTL_MS = '5000';

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { tryAcquireWorkspaceReplicationScopeLease } = await import('../state/workspaceReplicationScopeLease');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_scope_lease_stolen_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [{ digest: 'sha256:deadbeef', sizeBytes: 10 }],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_scope_lease_stolen_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_scope_lease_stolen_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const transferMissingBlobsToTargetCas = vi.fn(async () => {
        // The scope lease is held by the current process, but it expires; simulate another runner stealing it mid-flight.
        await tryAcquireWorkspaceReplicationScopeLease({
          activeServerDir,
          relationshipId: relationship.relationshipId,
          directionId: 'dir_1',
          ownerId: 'other-runner',
          nowMs: 7001,
          ttlMs: 60_000,
        });
        return { transferredFiles: 1, transferredBytes: 10 };
      });

      const applyPlan = vi.fn(async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }));
      const commitBaseline = vi.fn(async () => undefined);

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_scope_lease_stolen_1',
        now: () => 1000,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(transferMissingBlobsToTargetCas).toHaveBeenCalledTimes(1);
      expect(applyPlan).not.toHaveBeenCalled();
      expect(commitBaseline).not.toHaveBeenCalled();
      expect(result.status.checkpoint).not.toBe('apply_started');
      expect(result.status.checkpoint).not.toBe('apply_completed');
      expect(result.status.checkpoint).not.toBe('baseline_committed');
    } finally {
      if (previousScopeLeaseTtl === undefined) {
        delete process.env.HAPPIER_WORKSPACE_REPLICATION_SCOPE_LEASE_TTL_MS;
      } else {
        process.env.HAPPIER_WORKSPACE_REPLICATION_SCOPE_LEASE_TTL_MS = previousScopeLeaseTtl;
      }
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('resumes from blob_transfer_completed without re-transferring blobs', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-resume-transfer-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });

      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_resume_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_resume_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_resume_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'in_progress',
          phase: 'transfer_missing_blobs_to_target_cas',
          checkpoint: 'blob_transfer_completed',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });
      await expect(jobStore.read('job_resume_1')).resolves.toMatchObject({
        status: { checkpoint: 'blob_transfer_completed' },
      });

      const transferMissingBlobsToTargetCas = vi.fn(async () => ({ transferredFiles: 0, transferredBytes: 0 }));
      const applyPlan = vi.fn(async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }));
      const commitBaseline = vi.fn(async () => undefined);

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_resume_1',
        now: () => 42,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas,
        applyPlan,
        commitBaseline,
      });

      expect(transferMissingBlobsToTargetCas).not.toHaveBeenCalled();
      expect(applyPlan).toHaveBeenCalledTimes(1);
      expect(commitBaseline).toHaveBeenCalledTimes(1);
      expect(result.status.checkpoint).toBe('baseline_committed');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('hard-stops before marking completed when the lease is stolen after commitBaseline finishes (final lease guard)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-final-lease-guard-'));

    const previousLeaseTtl = process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS;
    process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS = '5000';

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { tryAcquireWorkspaceReplicationJobLease } = await import('../state/workspaceReplicationJobLease');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_final_lease_guard_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_final_lease_guard_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_final_lease_guard_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const commitBaseline = vi.fn(async () => {
        await tryAcquireWorkspaceReplicationJobLease({
          activeServerDir,
          jobId: 'job_final_lease_guard_1',
          ownerId: 'other-runner',
          nowMs: 7001,
          ttlMs: 60_000,
        });
      });

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_final_lease_guard_1',
        now: () => 1000,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas: async () => ({ transferredFiles: 0, transferredBytes: 0 }),
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }),
        commitBaseline,
      });

      expect(commitBaseline).toHaveBeenCalledTimes(1);
      expect(result.status.status).not.toBe('completed');
      expect(result.status.checkpoint).not.toBe('baseline_committed');
      await expect(jobStore.read('job_final_lease_guard_1')).resolves.not.toMatchObject({
        status: { status: 'completed' },
      });
    } finally {
      if (previousLeaseTtl === undefined) {
        delete process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS;
      } else {
        process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS = previousLeaseTtl;
      }
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('removes job staging on abort (cancel requested) before returning an aborted status', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-abort-cleanup-'));

    try {
      const { mkdir, writeFile, readFile } = await import('node:fs/promises');
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { createWorkspaceReplicationPaths } = await import('../state/workspaceReplicationPaths');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_abort_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_abort_cleanup_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_abort_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        cancelRequestedAtMs: 11,
        status: {
          status: 'in_progress',
          phase: 'transfer_missing_blobs_to_target_cas',
          checkpoint: 'blob_transfer_started',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const stagingPath = join(paths.stagingDirectory, 'job_abort_cleanup_1');
      await mkdir(stagingPath, { recursive: true });
      await writeFile(join(stagingPath, 'marker.txt'), 'staging\n');
      await expect(readFile(join(stagingPath, 'marker.txt'), 'utf8')).resolves.toBe('staging\n');

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_abort_cleanup_1',
        now: () => 50,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas: async () => ({ transferredFiles: 0, transferredBytes: 0 }),
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }),
        commitBaseline: async () => undefined,
      });

      expect(result.status.status).toBe('aborted');
      await expect(readFile(join(stagingPath, 'marker.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('removes job staging on successful completion (completed jobs should not leak staging artifacts)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-complete-cleanup-'));

    try {
      const { mkdir, writeFile, readFile } = await import('node:fs/promises');
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { createWorkspaceReplicationPaths } = await import('../state/workspaceReplicationPaths');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_complete_cleanup_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_complete_cleanup_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_complete_cleanup_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const stagingPath = join(paths.stagingDirectory, 'job_complete_cleanup_1');
      await mkdir(stagingPath, { recursive: true });
      await writeFile(join(stagingPath, 'marker.txt'), 'staging\n');
      await expect(readFile(join(stagingPath, 'marker.txt'), 'utf8')).resolves.toBe('staging\n');

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_complete_cleanup_1',
        now: () => 50,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas: async () => ({ transferredFiles: 0, transferredBytes: 0 }),
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }),
        commitBaseline: async () => undefined,
      });

      expect(result.status.status).toBe('completed');
      await expect(readFile(join(stagingPath, 'marker.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('removes job staging when marking the job failed (failed jobs should not leak staging artifacts)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-failed-cleanup-'));

    try {
      const { mkdir, writeFile, readFile } = await import('node:fs/promises');
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { createWorkspaceReplicationPaths } = await import('../state/workspaceReplicationPaths');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_fail_cleanup_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [{ digest: 'sha256:deadbeef', sizeBytes: 10 }],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_fail_cleanup_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_fail_cleanup_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const stagingPath = join(paths.stagingDirectory, 'job_fail_cleanup_1');
      await mkdir(stagingPath, { recursive: true });
      await writeFile(join(stagingPath, 'marker.txt'), 'staging\n');
      await expect(readFile(join(stagingPath, 'marker.txt'), 'utf8')).resolves.toBe('staging\n');

      await expect(executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_fail_cleanup_1',
        now: () => 55,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas: async () => {
          throw new Error('boom');
        },
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }),
        commitBaseline: async () => undefined,
      })).rejects.toThrow('boom');

      await expect(jobStore.read('job_fail_cleanup_1')).resolves.toMatchObject({
        status: { status: 'failed' },
      });
      await expect(readFile(join(stagingPath, 'marker.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('records a warning when resuming after stealing an expired lease (durable resume diagnostics)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-resume-warning-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { tryAcquireWorkspaceReplicationJobLease } = await import('../state/workspaceReplicationJobLease');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe' as const,
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_resume_warning_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_resume_warning_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_resume_warning_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_resume_warning_1',
        ownerId: 'stale-runner',
        nowMs: 1000,
        ttlMs: 10,
      });

      const result = await executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_resume_warning_1',
        now: () => 5000,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas: async () => ({ transferredFiles: 0, transferredBytes: 0 }),
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }),
        commitBaseline: async () => undefined,
      });

      expect(result.status.status).toBe('completed');
      await expect(jobStore.read('job_resume_warning_1')).resolves.toMatchObject({
        lastAttempt: {
          attemptNumber: 2,
          leaseId: expect.any(String),
          ownerId: expect.stringMatching(/^cli-daemon:/),
          acquiredAtMs: 5000,
        },
        status: {
          warnings: expect.arrayContaining(['resumed_existing_job']),
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('marks the job failed when a handler throws', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-failed-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      const offer: WorkspaceReplicationSourceOffer = {
        offerId: 'offer_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        sourceFingerprint: 'fp_1',
        manifest: { entries: [], fingerprint: 'fp_1' },
        blobIndex: [],
      };

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_fail_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: offer.offerId,
        mode: 'one_way_safe',
        correlationId: 'corr_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await expect(executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_fail_1',
        now: () => 55,
        resolveSourceOfferById: async () => offer,
        transferMissingBlobsToTargetCas: async () => {
          throw new Error('boom');
        },
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }),
        commitBaseline: async () => undefined,
      })).rejects.toThrow('boom');

      await expect(jobStore.read('job_fail_1')).resolves.toMatchObject({
        jobId: 'job_fail_1',
        failedAtMs: 55,
        lastErrorMessage: 'boom',
        status: {
          status: 'failed',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('marks the job failed when resolveSourceOfferById throws', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-exec-job-offer-throw-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
      const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
      const { executeWorkspaceReplicationJob } = await import('./executeWorkspaceReplicationJob');

      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
      const relationship = await relationships.ensureRelationship({
        sourceMachineId: 'machine-source',
        sourceWorkspaceRoot: '/source',
        targetMachineId: 'machine-target',
        targetWorkspaceRoot: '/target',
        mode: 'one_way_safe',
      });

      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_offer_throw_1',
        relationshipId: relationship.relationshipId,
        directionId: 'dir_1',
        offerId: 'offer_1',
        mode: 'one_way_safe',
        correlationId: 'corr_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await expect(executeWorkspaceReplicationJob({
        activeServerDir,
        jobStore,
        relationships,
        jobId: 'job_offer_throw_1',
        now: () => 55,
        resolveSourceOfferById: async () => {
          throw new Error('offer boom');
        },
        transferMissingBlobsToTargetCas: async () => ({ transferredFiles: 0, transferredBytes: 0 }),
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0, targetPath: '/target' }),
        commitBaseline: async () => undefined,
      })).rejects.toThrow('offer boom');

      await expect(jobStore.read('job_offer_throw_1')).resolves.toMatchObject({
        jobId: 'job_offer_throw_1',
        failedAtMs: 55,
        lastErrorMessage: 'offer boom',
        status: {
          status: 'failed',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
