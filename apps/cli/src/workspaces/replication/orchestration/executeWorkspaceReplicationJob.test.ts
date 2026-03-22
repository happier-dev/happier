import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';

describe('executeWorkspaceReplicationJob', () => {
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
        applyPlan: async () => ({ appliedFiles: 0, appliedBytes: 0 }),
        commitBaseline: async () => undefined,
      })).rejects.toThrow('boom');

      await expect(jobStore.read('job_fail_1')).resolves.toMatchObject({
        jobId: 'job_fail_1',
        failedAtMs: 55,
        lastErrorCode: 'job_run_failed',
        lastErrorMessage: 'boom',
        status: {
          status: 'failed',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
