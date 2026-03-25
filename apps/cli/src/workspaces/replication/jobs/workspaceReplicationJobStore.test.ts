import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { WorkspaceReplicationJobRecordInput } from './workspaceReplicationJobStore';

describe('workspaceReplicationJobStore', () => {
  it('does not depend on SessionHandoff protocol schemas (import-boundary)', async () => {
    const sourcePath = fileURLToPath(new URL('./workspaceReplicationJobStore.ts', import.meta.url));
    const contents = await readFile(sourcePath, 'utf8');
    expect(contents).not.toContain('SessionHandoffStatusSchema');
    expect(contents).not.toContain('SessionHandoffPrepareTargetResultGetResponseSchema');
  });

  it('persists engine-native replication jobs, strips unknown legacy fields, and finds them by correlation id', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-jobs-'));

    try {
      const {
        createWorkspaceReplicationJobStore,
      } = await import('./workspaceReplicationJobStore');

      const store = createWorkspaceReplicationJobStore({
        activeServerDir,
      });

      const legacyRawRecord: Record<string, unknown> = {
        jobId: 'job_prepare_1',
        correlationId: 'handoff_123',
        createdAtMs: 100,
        updatedAtMs: 100,
        // Unknown legacy/handoff-only fields must be stripped by the engine store.
        prepareTargetResult: { success: true },
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {},
          warnings: [],
          blockingDivergenceCandidates: [],
          // Unknown handoff-shaped keys must be stripped.
          handoffId: 'handoff_123',
        },
      };

      // This fixture intentionally does not satisfy the typed engine-native record shape;
      // it represents a legacy persisted record that the store must normalize/strip.
      await store.write(legacyRawRecord as unknown as WorkspaceReplicationJobRecordInput);

      await expect(store.read('job_prepare_1')).resolves.toMatchObject({
        jobId: 'job_prepare_1',
        correlationId: 'handoff_123',
        status: {
          status: 'pending',
          phase: 'planning',
        },
      });
      await expect(store.read('job_prepare_1')).resolves.not.toHaveProperty('prepareTargetResult');
      const loaded = await store.read('job_prepare_1');
      expect(loaded?.status).not.toHaveProperty('handoffId');
      await expect(store.findByCorrelationId('handoff_123')).resolves.toMatchObject({
        jobId: 'job_prepare_1',
        correlationId: 'handoff_123',
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('strips legacy transport-specific resume context fields while preserving the durable apply resume context', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-jobs-resume-context-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');

      const store = createWorkspaceReplicationJobStore({
        activeServerDir,
      });

      const recordWithLegacyResumeContextField = {
        schemaVersion: 1,
        jobId: 'job_resume_context_1',
        correlationId: 'corr_resume_context_1',
        relationshipId: 'rel_resume_context_1',
        directionId: 'dir_resume_context_1',
        offerId: 'offer_resume_context_1',
        mode: 'one_way_safe',
        createdAtMs: 100,
        updatedAtMs: 100,
        resumeContext: {
          apply: {
            targetPath: '/workspace/target',
            strategy: 'sync_changes',
            conflictPolicy: 'replace_existing',
          },
          blobPackPlanningMode: 'stable_full_offer',
        },
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {},
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      } as const;

      // This fixture intentionally contains a legacy transport-specific resume field that must be stripped.
      await store.write(recordWithLegacyResumeContextField as any);

      await expect(store.read('job_resume_context_1')).resolves.toMatchObject({
        jobId: 'job_resume_context_1',
        resumeContext: {
          apply: {
            targetPath: '/workspace/target',
            strategy: 'sync_changes',
            conflictPolicy: 'replace_existing',
          },
        },
      });
      const loaded = await store.read('job_resume_context_1');
      expect(loaded?.resumeContext).not.toHaveProperty('blobPackPlanningMode');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a persisted job file omits schemaVersion (no undeployed compatibility)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-jobs-'));

    try {
      const { createWorkspaceReplicationPaths, resolveWorkspaceReplicationJobPath } = await import('../state/workspaceReplicationPaths');
      const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const jobPath = resolveWorkspaceReplicationJobPath({
        jobsDirectory: paths.jobsDirectory,
        jobId: 'job_legacy_1',
      });

      await mkdir(paths.jobsDirectory, { recursive: true });
      await writeFile(jobPath, JSON.stringify({
        jobId: 'job_legacy_1',
        correlationId: 'handoff_legacy',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'running',
          phase: 'initializing',
        },
      }), 'utf8');

      const store = createWorkspaceReplicationJobStore({ activeServerDir });
      await expect(store.read('job_legacy_1')).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a persisted job file uses an unsupported schemaVersion', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-jobs-schema-'));

    try {
      const { createWorkspaceReplicationPaths, resolveWorkspaceReplicationJobPath } = await import('../state/workspaceReplicationPaths');
      const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const jobPath = resolveWorkspaceReplicationJobPath({
        jobsDirectory: paths.jobsDirectory,
        jobId: 'job_schema_unsupported',
      });

      await mkdir(paths.jobsDirectory, { recursive: true });
      await writeFile(jobPath, JSON.stringify({
        schemaVersion: 2,
        jobId: 'job_schema_unsupported',
        correlationId: 'handoff_schema',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          status: 'completed',
          phase: 'commit_baseline',
          checkpoint: 'baseline_committed',
        },
      }), 'utf8');

      const store = createWorkspaceReplicationJobStore({ activeServerDir });
      await expect(store.read('job_schema_unsupported')).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('preserves correlation/relationship identity fields across partial writes (sticky job identity)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-jobs-sticky-identity-'));

    try {
      const {
        createWorkspaceReplicationJobStore,
      } = await import('./workspaceReplicationJobStore');

      const store = createWorkspaceReplicationJobStore({
        activeServerDir,
      });

      await store.write({
        schemaVersion: 1,
        jobId: 'job_identity_1',
        correlationId: 'corr_identity_1',
        relationshipId: 'rel_identity_1',
        directionId: 'dir_identity_1',
        offerId: 'offer_identity_1',
        mode: 'one_way_safe',
        createdAtMs: 100,
        updatedAtMs: 100,
        status: {
          status: 'pending',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {},
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      // Simulate a stale/partial writer that does not include identity fields.
      await store.write({
        schemaVersion: 1,
        jobId: 'job_identity_1',
        createdAtMs: 100,
        updatedAtMs: 200,
        status: {
          status: 'in_progress',
          phase: 'planning',
          checkpoint: 'relationship_resolved',
          progressCounters: {},
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await expect(store.read('job_identity_1')).resolves.toMatchObject({
        jobId: 'job_identity_1',
        correlationId: 'corr_identity_1',
        relationshipId: 'rel_identity_1',
        directionId: 'dir_identity_1',
        offerId: 'offer_identity_1',
        mode: 'one_way_safe',
        status: {
          checkpoint: 'relationship_resolved',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('preserves and monotonically advances lastAttempt across partial/stale writes (durable attempt semantics)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-jobs-attempts-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');

      const store = createWorkspaceReplicationJobStore({ activeServerDir });

      await store.write({
        schemaVersion: 1,
        jobId: 'job_attempts_1',
        correlationId: 'corr_attempts_1',
        createdAtMs: 100,
        updatedAtMs: 100,
        lastAttempt: {
          attemptNumber: 2,
          leaseId: 'lease_2',
          ownerId: 'runner_2',
          acquiredAtMs: 200,
        },
        status: {
          status: 'in_progress',
          phase: 'planning',
          checkpoint: 'relationship_resolved',
          progressCounters: {},
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      // Partial writer attempts to clear lastAttempt.
      await store.write({
        schemaVersion: 1,
        jobId: 'job_attempts_1',
        createdAtMs: 100,
        updatedAtMs: 110,
        status: {
          status: 'in_progress',
          phase: 'planning',
          checkpoint: 'missing_digests_negotiated',
          progressCounters: {},
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await expect(store.read('job_attempts_1')).resolves.toMatchObject({
        lastAttempt: {
          attemptNumber: 2,
          leaseId: 'lease_2',
          ownerId: 'runner_2',
          acquiredAtMs: 200,
        },
      });

      // Stale writer attempts to regress attempt number.
      await store.write({
        schemaVersion: 1,
        jobId: 'job_attempts_1',
        createdAtMs: 100,
        updatedAtMs: 120,
        lastAttempt: {
          attemptNumber: 1,
          leaseId: 'lease_1',
          ownerId: 'runner_1',
          acquiredAtMs: 100,
        },
        status: {
          status: 'in_progress',
          phase: 'planning',
          checkpoint: 'missing_digests_negotiated',
          progressCounters: {},
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await expect(store.read('job_attempts_1')).resolves.toMatchObject({
        lastAttempt: {
          attemptNumber: 2,
          leaseId: 'lease_2',
          ownerId: 'runner_2',
          acquiredAtMs: 200,
        },
      });

      // New runner advances attempt number.
      await store.write({
        schemaVersion: 1,
        jobId: 'job_attempts_1',
        createdAtMs: 100,
        updatedAtMs: 130,
        lastAttempt: {
          attemptNumber: 3,
          leaseId: 'lease_3',
          ownerId: 'runner_3',
          acquiredAtMs: 300,
        },
        status: {
          status: 'in_progress',
          phase: 'planning',
          checkpoint: 'missing_digests_negotiated',
          progressCounters: {},
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await expect(store.read('job_attempts_1')).resolves.toMatchObject({
        lastAttempt: {
          attemptNumber: 3,
          leaseId: 'lease_3',
          ownerId: 'runner_3',
          acquiredAtMs: 300,
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('does not drop terminal status updates when a stale writer regresses checkpoint (terminal status wins, checkpoint monotonic)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-jobs-terminal-regression-'));

    try {
      const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');

      const store = createWorkspaceReplicationJobStore({
        activeServerDir,
      });

      await store.write({
        schemaVersion: 1,
        jobId: 'job_terminal_regression_1',
        createdAtMs: 100,
        updatedAtMs: 150,
        status: {
          status: 'in_progress',
          phase: 'apply',
          checkpoint: 'apply_started',
          progressCounters: {
            plannedFiles: 10,
            plannedBytes: 100,
            transferredFiles: 5,
            transferredBytes: 50,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      // Simulate a stale writer that regresses the checkpoint but still needs to persist a terminal failure.
      await store.write({
        schemaVersion: 1,
        jobId: 'job_terminal_regression_1',
        createdAtMs: 100,
        updatedAtMs: 200,
        failedAtMs: 200,
        lastErrorMessage: 'boom',
        status: {
          status: 'failed',
          phase: 'planning',
          checkpoint: 'relationship_resolved',
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

      await expect(store.read('job_terminal_regression_1')).resolves.toMatchObject({
        jobId: 'job_terminal_regression_1',
        failedAtMs: 200,
        lastErrorMessage: 'boom',
        status: {
          status: 'failed',
          checkpoint: 'apply_started',
          progressCounters: {
            transferredFiles: 5,
            transferredBytes: 50,
          },
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
