import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workspaceReplicationGc (restart recovery)', () => {
    it('marks non-terminal jobs awaiting_recovery (restart required) and clears the job lease directory after restart', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-recovery-'));
        try {
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
            const { recoverWorkspaceReplicationJobsAfterRestart } = await import('./workspaceReplicationGc');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_recovery_pending',
                createdAtMs: 1000,
                updatedAtMs: 1000,
                status: {
                    status: 'in_progress',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'blob_transfer_started',
                    progressCounters: {
                        plannedFiles: 1,
                        plannedBytes: 10,
                        transferredFiles: 0,
                        transferredBytes: 0,
                        appliedFiles: 0,
                        appliedBytes: 0,
                    },
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            });

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            const leaseDir = join(paths.stagingDirectory, 'job_recovery_pending', 'lease');
            await mkdir(leaseDir, { recursive: true });
            await writeFile(join(leaseDir, 'lease.json'), JSON.stringify({
                ownerId: 'owner_a',
                acquiredAtMs: 1000,
                renewedAtMs: 1000,
                expiresAtMs: 5000,
            }), 'utf8');
            await expect(access(join(leaseDir, 'lease.json'))).resolves.toBeUndefined();

            const nowMs = 42_000;
            const recovered = await recoverWorkspaceReplicationJobsAfterRestart({
                activeServerDir,
                nowMs,
            });
            expect(recovered.recoveredJobIds).toContain('job_recovery_pending');

            const persisted = await jobStore.read('job_recovery_pending');
            expect(persisted).toMatchObject({
                jobId: 'job_recovery_pending',
                updatedAtMs: nowMs,
                awaitingRecoveryAtMs: nowMs,
                status: {
                    status: 'awaiting_recovery',
                },
            });
            expect(persisted?.status.warnings ?? []).toContain('recovered_after_daemon_restart');
            expect(persisted?.lastErrorMessage?.toLowerCase()).toContain('daemon');
            await expect(access(join(leaseDir, 'lease.json'))).rejects.toThrow();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('does not recover jobs when the lease owner pid is still alive (avoid concurrent daemon runners)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-recovery-lease-alive-'));
        try {
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
            const { recoverWorkspaceReplicationJobsAfterRestart } = await import('./workspaceReplicationGc');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_recovery_lease_alive',
                createdAtMs: 1000,
                updatedAtMs: 1000,
                status: {
                    status: 'in_progress',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'blob_transfer_started',
                    progressCounters: {
                        plannedFiles: 1,
                        plannedBytes: 10,
                        transferredFiles: 0,
                        transferredBytes: 0,
                        appliedFiles: 0,
                        appliedBytes: 0,
                    },
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            });

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            const leaseDir = join(paths.stagingDirectory, 'job_recovery_lease_alive', 'lease');
            await mkdir(leaseDir, { recursive: true });
            await writeFile(join(leaseDir, 'lease.json'), JSON.stringify({
                ownerId: `cli-daemon:${process.pid}`,
                acquiredAtMs: 1000,
                renewedAtMs: 1000,
                expiresAtMs: Date.now() + 60_000,
            }), 'utf8');
            await expect(access(join(leaseDir, 'lease.json'))).resolves.toBeUndefined();

            const nowMs = Date.now();
            const recovered = await recoverWorkspaceReplicationJobsAfterRestart({
                activeServerDir,
                nowMs,
            });
            expect(recovered.recoveredJobIds).not.toContain('job_recovery_lease_alive');

            const persisted = await jobStore.read('job_recovery_lease_alive');
            expect(persisted).toMatchObject({
                jobId: 'job_recovery_lease_alive',
                updatedAtMs: 1000,
                status: {
                    status: 'in_progress',
                },
            });
            await expect(access(join(leaseDir, 'lease.json'))).resolves.toBeUndefined();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('aborts jobs with cancelRequestedAtMs set and keeps the record terminal', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-recovery-abort-'));
        try {
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
            const { recoverWorkspaceReplicationJobsAfterRestart } = await import('./workspaceReplicationGc');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_recovery_cancelled',
                createdAtMs: 1000,
                updatedAtMs: 2000,
                cancelRequestedAtMs: 2500,
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

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            const leaseDir = join(paths.stagingDirectory, 'job_recovery_cancelled', 'lease');
            await mkdir(leaseDir, { recursive: true });
            await writeFile(join(leaseDir, 'lease.json'), JSON.stringify({
                ownerId: 'owner_a',
                acquiredAtMs: 1000,
                renewedAtMs: 1000,
                expiresAtMs: 5000,
            }), 'utf8');

            const nowMs = 50_000;
            await recoverWorkspaceReplicationJobsAfterRestart({
                activeServerDir,
                nowMs,
            });

            const persisted = await jobStore.read('job_recovery_cancelled');
            expect(persisted).toMatchObject({
                jobId: 'job_recovery_cancelled',
                cancelRequestedAtMs: 2500,
                abortedAtMs: nowMs,
                updatedAtMs: nowMs,
                status: {
                    status: 'aborted',
                },
            });
            expect(persisted?.lastErrorMessage).toBe('Workspace replication aborted after daemon restart');
            await expect(access(join(leaseDir, 'lease.json'))).rejects.toThrow();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('ignores invalid job JSON while recovering other jobs', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-recovery-invalid-'));
        try {
            const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { recoverWorkspaceReplicationJobsAfterRestart } = await import('./workspaceReplicationGc');

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(paths.jobsDirectory, { recursive: true });
            await writeFile(join(paths.jobsDirectory, 'job_invalid.json'), '{not-json', 'utf8');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                jobId: 'job_recovery_ok',
                createdAtMs: 1000,
                updatedAtMs: 1000,
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

            const nowMs = 10_000;
            const recovered = await recoverWorkspaceReplicationJobsAfterRestart({
                activeServerDir,
                nowMs,
            });
            expect(recovered.recoveredJobIds).toContain('job_recovery_ok');

            const persisted = await jobStore.read('job_recovery_ok');
            expect(persisted?.updatedAtMs).toBe(nowMs);
            expect(persisted?.status.warnings ?? []).toContain('recovered_after_daemon_restart');
            expect(persisted?.status.status).toBe('awaiting_recovery');

            const rawInvalid = await readFile(join(paths.jobsDirectory, 'job_invalid.json'), 'utf8');
            expect(rawInvalid).toBe('{not-json');
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
