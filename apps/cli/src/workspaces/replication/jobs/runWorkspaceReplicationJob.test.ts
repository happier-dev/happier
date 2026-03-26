import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('runWorkspaceReplicationJob', () => {
    it('throws a WorkspaceReplicationError when the job does not exist', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-run-job-missing-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { runWorkspaceReplicationJob } = await import('./runWorkspaceReplicationJob');
            const { WorkspaceReplicationError } = await import('../workspaceReplicationError');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });

            await expect(runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_missing_1',
                run: async (current) => current,
            })).rejects.toMatchObject({
                name: 'WorkspaceReplicationError',
                code: 'job_not_found',
            });

            await expect(runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_missing_1',
                run: async (current) => current,
            })).rejects.toBeInstanceOf(WorkspaceReplicationError);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('persists the callback result with an updated timestamp', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-run-job-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { runWorkspaceReplicationJob } = await import('./runWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
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

            let runnerInvoked = false;
            const now = vi.fn(() => {
                if (!runnerInvoked) {
                    throw new Error('now() called before runner completed');
                }
                return 25;
            });
            const result = await runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_1',
                now,
                run: async (current) => {
                    runnerInvoked = true;
                    return {
                        ...current,
                        updatedAtMs: 24,
                        completedAtMs: 24,
                        status: {
                            ...current.status,
                            status: 'completed',
                            phase: 'commit_baseline',
                            checkpoint: 'baseline_committed',
                        },
                    };
                },
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
                schemaVersion: 1,
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

            let runnerInvoked = false;
            await expect(runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_2',
                now: () => {
                    if (!runnerInvoked) {
                        throw new Error('now() called before runner completed');
                    }
                    return 44;
                },
                run: async () => {
                    runnerInvoked = true;
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
                schemaVersion: 1,
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

            let runnerInvoked = false;
            await expect(runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_cancel_1',
                now: () => {
                    if (!runnerInvoked) {
                        throw new Error('now() called before runner completed');
                    }
                    return 60;
                },
                run: async () => {
                    runnerInvoked = true;
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

    it('does not lose a concurrent cancellation request while persisting runner progress (cancelRequestedAtMs is sticky)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-run-job-cancel-sticky-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { runWorkspaceReplicationJob } = await import('./runWorkspaceReplicationJob');
            const { abortWorkspaceReplicationJob } = await import('./abortWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_cancel_sticky_1',
                correlationId: 'handoff_cancel_sticky_1',
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

            await runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_cancel_sticky_1',
                now: () => 60,
                run: async (current) => {
                    // Simulate a cancellation request arriving while the job runner is still executing.
                    await abortWorkspaceReplicationJob({
                        jobStore,
                        jobId: 'job_cancel_sticky_1',
                        now: () => 50,
                    });

                    // Return a progress update that does not include cancelRequestedAtMs.
                    return {
                        ...current,
                        status: {
                            ...current.status,
                            status: 'in_progress',
                            phase: 'apply',
                            checkpoint: 'apply_started',
                        },
                    };
                },
            });

            await expect(jobStore.read('job_cancel_sticky_1')).resolves.toMatchObject({
                jobId: 'job_cancel_sticky_1',
                cancelRequestedAtMs: 50,
                status: {
                    status: 'in_progress',
                    phase: 'apply',
                    checkpoint: 'apply_started',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('returns the merged record so concurrent cancellation is visible to callers', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-run-job-merged-cancel-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { runWorkspaceReplicationJob } = await import('./runWorkspaceReplicationJob');
            const { abortWorkspaceReplicationJob } = await import('./abortWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_merge_cancel_1',
                correlationId: 'handoff_merge_cancel_1',
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

            const result = await runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_merge_cancel_1',
                now: () => 60,
                run: async (current) => {
                    await abortWorkspaceReplicationJob({
                        jobStore,
                        jobId: 'job_merge_cancel_1',
                        now: () => 50,
                    });
                    return {
                        ...current,
                        status: {
                            ...current.status,
                            status: 'in_progress',
                            phase: 'apply',
                            checkpoint: 'apply_started',
                        },
                    };
                },
            });

            expect(result.cancelRequestedAtMs).toBe(50);
            expect(result.status.checkpoint).toBe('apply_started');
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('returns the merged record when the store rejects a checkpoint regression (fail-closed resume semantics)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-run-job-merged-regression-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { runWorkspaceReplicationJob } = await import('./runWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_merge_regression_1',
                correlationId: 'handoff_merge_regression_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'in_progress',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'blob_transfer_completed',
                    progressCounters: {},
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            });

            const result = await runWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_merge_regression_1',
                now: () => 60,
                run: async (current) => ({
                    ...current,
                    status: {
                        ...current.status,
                        status: 'in_progress',
                        phase: 'negotiate_missing_digests',
                        checkpoint: 'missing_digests_negotiated',
                    },
                }),
            });

            expect(result.status.checkpoint).toBe('blob_transfer_completed');
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
