import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('abortWorkspaceReplicationJob', () => {
    it('marks a running job cancelled and aborted', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-abort-job-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { abortWorkspaceReplicationJob } = await import('./abortWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_abort_1',
                correlationId: 'handoff_abort_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'running',
                    phase: 'transferring_blobs',
                    warnings: [],
                },
            });

            const result = await abortWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_abort_1',
                now: () => 77,
            });

            expect(result).toMatchObject({
                jobId: 'job_abort_1',
                cancelRequestedAtMs: 77,
                abortedAtMs: 77,
                updatedAtMs: 77,
                status: {
                    status: 'aborted',
                    phase: 'transferring_blobs',
                },
            });
            await expect(jobStore.read('job_abort_1')).resolves.toMatchObject({
                cancelRequestedAtMs: 77,
                abortedAtMs: 77,
                status: {
                    status: 'aborted',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('leaves terminal jobs unchanged', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-abort-job-terminal-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { abortWorkspaceReplicationJob } = await import('./abortWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_abort_2',
                correlationId: 'handoff_abort_2',
                createdAtMs: 10,
                updatedAtMs: 20,
                completedAtMs: 20,
                status: {
                    status: 'completed',
                    phase: 'finalizing',
                    warnings: [],
                },
            });

            await expect(abortWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_abort_2',
                now: () => 99,
            })).resolves.toMatchObject({
                jobId: 'job_abort_2',
                completedAtMs: 20,
                updatedAtMs: 20,
                status: {
                    status: 'completed',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
