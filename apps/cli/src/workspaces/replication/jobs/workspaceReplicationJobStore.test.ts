import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workspaceReplicationJobStore', () => {
  it('persists handoff prepare-target jobs and finds them by correlation id', async () => {
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
        status: {
          handoffId: 'handoff_123',
          jobId: 'job_prepare_1',
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
      });

      await expect(store.read('job_prepare_1')).resolves.toMatchObject({
        jobId: 'job_prepare_1',
        correlationId: 'handoff_123',
        status: {
          handoffId: 'handoff_123',
          jobId: 'job_prepare_1',
          status: 'pending',
          phase: 'staging_target',
        },
      });
      await expect(store.findByCorrelationId('handoff_123')).resolves.toMatchObject({
        jobId: 'job_prepare_1',
        correlationId: 'handoff_123',
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
