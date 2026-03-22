import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('runWorkspaceReplicationJob', () => {
    it('persists the callback result with an updated timestamp', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-run-job-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { runWorkspaceReplicationJob } = await import('./runWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_1',
                correlationId: 'handoff_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    handoffId: 'handoff_1',
                    jobId: 'job_1',
                    status: 'pending',
                    phase: 'staging_target',
                    recoveryActions: ['restart_on_source'],
                },
            });

            const now = vi.fn(() => 25);
            const result = await runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_1',
                now,
                run: async (current) => ({
                    ...current,
                    updatedAtMs: 24,
                    completedAtMs: 24,
                    status: {
                        ...current.status,
                        status: 'completed',
                        phase: 'finalizing',
                    },
                }),
            });

            expect(now).toHaveBeenCalledTimes(1);
            expect(result).toMatchObject({
                jobId: 'job_1',
                completedAtMs: 24,
                updatedAtMs: 25,
                status: {
                    handoffId: 'handoff_1',
                    jobId: 'job_1',
                    status: 'completed',
                    phase: 'finalizing',
                },
            });
            await expect(jobStore.read('job_1')).resolves.toMatchObject({
                jobId: 'job_1',
                completedAtMs: 24,
                updatedAtMs: 25,
                status: {
                    status: 'completed',
                    phase: 'finalizing',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('marks the job failed when the runner throws', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-run-job-failed-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { runWorkspaceReplicationJob } = await import('./runWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_2',
                correlationId: 'handoff_2',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    handoffId: 'handoff_2',
                    jobId: 'job_2',
                    status: 'pending',
                    phase: 'staging_target',
                    recoveryActions: ['restart_on_source'],
                },
            });

            await expect(runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_2',
                now: () => 44,
                run: async () => {
                    throw new Error('boom');
                },
            })).rejects.toThrow('boom');

            await expect(jobStore.read('job_2')).resolves.toMatchObject({
                jobId: 'job_2',
                failedAtMs: 44,
                updatedAtMs: 44,
                lastErrorMessage: 'boom',
                status: {
                    status: 'failed',
                    phase: 'staging_target',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
