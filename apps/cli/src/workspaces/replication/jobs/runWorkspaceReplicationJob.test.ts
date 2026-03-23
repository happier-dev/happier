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
                    status: 'pending',
                    phase: 'planning',
                    checkpoint: 'job_created',
                    progressCounters: {},
                    warnings: [],
                    blockingDivergenceCandidates: [],
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
                        phase: 'commit_baseline',
                        checkpoint: 'baseline_committed',
                    },
                }),
            });

            expect(now).toHaveBeenCalledTimes(1);
            expect(result).toMatchObject({
                jobId: 'job_1',
                completedAtMs: 24,
                updatedAtMs: 25,
                status: {
                    status: 'completed',
                    phase: 'commit_baseline',
                    checkpoint: 'baseline_committed',
                },
            });
            await expect(jobStore.read('job_1')).resolves.toMatchObject({
                jobId: 'job_1',
                completedAtMs: 24,
                updatedAtMs: 25,
                status: {
                    status: 'completed',
                    phase: 'commit_baseline',
                    checkpoint: 'baseline_committed',
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
                    status: 'pending',
                    phase: 'planning',
                    checkpoint: 'job_created',
                    progressCounters: {},
                    warnings: [],
                    blockingDivergenceCandidates: [],
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
                    phase: 'planning',
                    checkpoint: 'job_created',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('marks the job aborted (not failed) when the runner throws a cancellation error', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-run-job-cancelled-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { runWorkspaceReplicationJob } = await import('./runWorkspaceReplicationJob');
            const { WorkspaceReplicationJobCancelRequestedError } = await import('../safety/workspaceReplicationJobCancelRequestedError');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_cancel_1',
                correlationId: 'handoff_cancel_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'in_progress',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'blob_transfer_started',
                    progressCounters: {},
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            });

            await expect(runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_cancel_1',
                now: () => 60,
                run: async () => {
                    throw new WorkspaceReplicationJobCancelRequestedError('job_cancel_1');
                },
            })).rejects.toThrow(WorkspaceReplicationJobCancelRequestedError);

            await expect(jobStore.read('job_cancel_1')).resolves.toMatchObject({
                jobId: 'job_cancel_1',
                cancelRequestedAtMs: 60,
                abortedAtMs: 60,
                updatedAtMs: 60,
                status: {
                    status: 'aborted',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'blob_transfer_started',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
