import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('abortWorkspaceReplicationJob', () => {
    it('requests cancellation for a running job without racing the runner (sets cancelRequestedAtMs)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-abort-job-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { abortWorkspaceReplicationJob } = await import('./abortWorkspaceReplicationJob');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_abort_1',
                correlationId: 'handoff_abort_1',
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

            const result = await abortWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_abort_1',
                now: () => 77,
            });

            expect(result).toMatchObject({
                jobId: 'job_abort_1',
                cancelRequestedAtMs: 77,
                updatedAtMs: 77,
                status: {
                    status: 'in_progress',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'blob_transfer_started',
                },
            });
            await expect(jobStore.read('job_abort_1')).resolves.toMatchObject({
                cancelRequestedAtMs: 77,
                status: {
                    status: 'in_progress',
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
                schemaVersion: 1,
                jobId: 'job_abort_2',
                correlationId: 'handoff_abort_2',
                createdAtMs: 10,
                updatedAtMs: 20,
                completedAtMs: 20,
                status: {
                    status: 'completed',
                    phase: 'commit_baseline',
                    checkpoint: 'baseline_committed',
                    progressCounters: {},
                    warnings: [],
                    blockingDivergenceCandidates: [],
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

    it('aborts a pending job immediately when no runner holds the lease (marks aborted + cleans staging)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-abort-job-pending-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('./workspaceReplicationJobStore');
            const { abortWorkspaceReplicationJob } = await import('./abortWorkspaceReplicationJob');
            const { createWorkspaceReplicationPaths, resolveWorkspaceReplicationJobStagingDirectory } = await import(
                '../state/workspaceReplicationPaths'
            );

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_abort_3',
                correlationId: 'handoff_abort_3',
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

            const result = await abortWorkspaceReplicationJob({
                jobStore,
                jobId: 'job_abort_3',
                activeServerDir,
                now: () => 77,
            });

            expect(result).toMatchObject({
                jobId: 'job_abort_3',
                cancelRequestedAtMs: 77,
                abortedAtMs: 77,
                updatedAtMs: 77,
                status: {
                    status: 'aborted',
                },
            });

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            const stagingDir = resolveWorkspaceReplicationJobStagingDirectory({
                stagingDirectory: paths.stagingDirectory,
                jobId: 'job_abort_3',
            });
            await expect(stat(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
