import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workspaceReplicationGc', () => {
    it('removes terminal jobs once they age past the retention window', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { gcWorkspaceReplicationJobs } = await import('./workspaceReplicationGc');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_keep_running',
                correlationId: 'handoff_keep_running',
                createdAtMs: 100,
                updatedAtMs: 100,
                status: {
                    handoffId: 'handoff_keep_running',
                    jobId: 'job_keep_running',
                    status: 'in_progress',
                    phase: 'transferring',
                    recoveryActions: ['keep_stopped'],
                },
            });
            await jobStore.write({
                jobId: 'job_remove_completed',
                correlationId: 'handoff_remove_completed',
                createdAtMs: 10,
                updatedAtMs: 10,
                completedAtMs: 10,
                status: {
                    handoffId: 'handoff_remove_completed',
                    jobId: 'job_remove_completed',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });

            const result = await gcWorkspaceReplicationJobs({
                activeServerDir,
                nowMs: 200,
                terminalTtlMs: 50,
            });

            expect(result.removedJobIds).toEqual(['job_remove_completed']);
            await expect(jobStore.read('job_remove_completed')).resolves.toBeNull();
            await expect(jobStore.read('job_keep_running')).resolves.toMatchObject({
                jobId: 'job_keep_running',
                status: {
                    status: 'in_progress',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
