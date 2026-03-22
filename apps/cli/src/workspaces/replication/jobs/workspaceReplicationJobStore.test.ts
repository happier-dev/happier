import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

      await store.write({
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
      });

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

  it('normalizes legacy persisted job files into the current engine schema (backwards-safe read)', async () => {
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
      await expect(store.read('job_legacy_1')).resolves.toMatchObject({
        jobId: 'job_legacy_1',
        correlationId: 'handoff_legacy',
        status: {
          status: 'in_progress',
          phase: 'planning',
          checkpoint: 'job_created',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
