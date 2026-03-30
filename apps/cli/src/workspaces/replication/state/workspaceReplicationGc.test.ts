import { mkdtemp, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workspaceReplicationGc', () => {
    it('removes terminal jobs once they age past the retention window', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
            const { gcWorkspaceReplicationJobs } = await import('./workspaceReplicationGc');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            const paths = createWorkspaceReplicationPaths({ activeServerDir });

            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_keep_running',
                correlationId: 'handoff_keep_running',
                createdAtMs: 100,
                updatedAtMs: 100,
                status: {
                    status: 'in_progress',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'blob_transfer_started',
                    progressCounters: {},
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_remove_completed',
                correlationId: 'handoff_remove_completed',
                createdAtMs: 10,
                updatedAtMs: 10,
                completedAtMs: 10,
                status: {
                    status: 'completed',
                    phase: 'commit_baseline',
                    checkpoint: 'baseline_committed',
                    progressCounters: {},
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            });

            // Seed staging directories for both jobs; GC must not delete active job staging data.
            const keepRunningStagingDir = join(paths.stagingDirectory, 'job_keep_running', 'blob-packs', 'pack_keep');
            const completedStagingDir = join(paths.stagingDirectory, 'job_remove_completed', 'blob-packs', 'pack_drop');
            await mkdir(keepRunningStagingDir, { recursive: true });
            await mkdir(completedStagingDir, { recursive: true });
            const keepRunningStagingFile = join(keepRunningStagingDir, 'chunk.part');
            const completedStagingFile = join(completedStagingDir, 'chunk.part');
            await writeFile(keepRunningStagingFile, Buffer.from('keep', 'utf8'));
            await writeFile(completedStagingFile, Buffer.from('drop', 'utf8'));

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

            // Terminal-job staging is eligible for cleanup; active-job staging must remain.
            await expect(import('node:fs/promises').then(({ access }) => access(completedStagingDir))).rejects.toThrow();
            await expect(import('node:fs/promises').then(({ access }) => access(keepRunningStagingFile))).resolves.toBeUndefined();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('removes legacy terminal job files that use older phase/status encodings', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-legacy-'));

        try {
            const { mkdir, writeFile } = await import('node:fs/promises');
            const {
                createWorkspaceReplicationPaths,
                resolveWorkspaceReplicationJobPath,
            } = await import('./workspaceReplicationPaths');
            const { gcWorkspaceReplicationJobs } = await import('./workspaceReplicationGc');

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(paths.jobsDirectory, { recursive: true });

            const jobPath = resolveWorkspaceReplicationJobPath({
                jobsDirectory: paths.jobsDirectory,
                jobId: 'job_legacy_completed',
            });

            // This intentionally does NOT match the current strict enum surface (phase/checkpoint);
            // GC must still normalize legacy persisted values so terminal jobs are cleaned up.
            await writeFile(jobPath, JSON.stringify({
                schemaVersion: 1,
                jobId: 'job_legacy_completed',
                correlationId: 'legacy_corr',
                createdAtMs: 10,
                updatedAtMs: 10,
                completedAtMs: 10,
                status: {
                    status: 'completed',
                    phase: 'finalizing',
                },
            }), 'utf8');

            const result = await gcWorkspaceReplicationJobs({
                activeServerDir,
                nowMs: 200,
                terminalTtlMs: 50,
            });

            expect(result.removedJobIds).toEqual(['job_legacy_completed']);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('does not throw when a terminal job record contains an invalid jobId (best-effort GC)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-invalid-jobid-'));

        try {
            const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
            const { gcWorkspaceReplicationJobs } = await import('./workspaceReplicationGc');
            const { access } = await import('node:fs/promises');

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(paths.jobsDirectory, { recursive: true });

            // Intentionally invalid id for resolveWorkspaceReplicationJobPath; GC must not throw.
            const jobId = 'job invalid';
            const jobFilePath = join(paths.jobsDirectory, 'job invalid.json');

            await writeFile(jobFilePath, JSON.stringify({
                schemaVersion: 1,
                jobId,
                correlationId: 'handoff_invalid_jobid',
                createdAtMs: 10,
                updatedAtMs: 10,
                completedAtMs: 10,
                status: {
                    status: 'completed',
                    phase: 'commit_baseline',
                    checkpoint: 'baseline_committed',
                    progressCounters: {},
                    warnings: [],
                    blockingDivergenceCandidates: [],
                },
            }), 'utf8');

            const result = await gcWorkspaceReplicationJobs({
                activeServerDir,
                nowMs: 200,
                terminalTtlMs: 50,
            });

            expect(result.removedJobIds).toEqual([jobId]);
            await expect(access(jobFilePath)).rejects.toThrow();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('skips CAS GC when there are active jobs', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-cas-active-'));

        try {
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const {
                createWorkspaceReplicationPaths,
                resolveWorkspaceReplicationCasBlobPath,
            } = await import('./workspaceReplicationPaths');
            const { gcWorkspaceReplicationCas } = await import('./workspaceReplicationGc');
            const { access } = await import('node:fs/promises');

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(join(paths.casDirectory, 'sha256'), { recursive: true });

            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_active',
                correlationId: 'handoff_active',
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

            const digest = `sha256:${'d'.repeat(64)}`;
            const blobPath = resolveWorkspaceReplicationCasBlobPath({ casDirectory: paths.casDirectory, digest });
            await mkdir(dirname(blobPath), { recursive: true });
            await writeFile(blobPath, Buffer.from('payload', 'utf8'));

            const result = await gcWorkspaceReplicationCas({
                activeServerDir,
                nowMs: 10_000,
                unreferencedTtlMs: 1,
            });

            expect(result.skippedDueToActiveJobs).toBe(true);
            expect(result.removedDigests).toEqual([]);
            await expect(access(blobPath)).resolves.toBeUndefined();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('fails closed (skips) CAS GC when a job record cannot be parsed', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-cas-unparseable-'));

        try {
            const { createWorkspaceReplicationPaths, resolveWorkspaceReplicationCasBlobPath } = await import('./workspaceReplicationPaths');
            const { gcWorkspaceReplicationCas } = await import('./workspaceReplicationGc');
            const { access } = await import('node:fs/promises');

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(paths.jobsDirectory, { recursive: true });
            await mkdir(join(paths.casDirectory, 'sha256'), { recursive: true });

            await writeFile(join(paths.jobsDirectory, 'job_corrupt.json'), '{ this is not json', 'utf8');

            const digest = `sha256:${'e'.repeat(64)}`;
            const blobPath = resolveWorkspaceReplicationCasBlobPath({ casDirectory: paths.casDirectory, digest });
            await mkdir(dirname(blobPath), { recursive: true });
            await writeFile(blobPath, Buffer.from('payload', 'utf8'));

            const result = await gcWorkspaceReplicationCas({
                activeServerDir,
                nowMs: 10_000,
                unreferencedTtlMs: 1,
            });

            expect(result.skippedDueToActiveJobs).toBe(true);
            expect(result.removedDigests).toEqual([]);
            await expect(access(blobPath)).resolves.toBeUndefined();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('removes orphaned staging directories that are older than the retention window', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-staging-orphans-'));

        try {
            const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
            const { gcWorkspaceReplicationJobs } = await import('./workspaceReplicationGc');
            const { access } = await import('node:fs/promises');

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            const orphanStagingDir = join(paths.stagingDirectory, 'job_orphan_1', 'blob-packs', 'pack_orphan');
            await mkdir(orphanStagingDir, { recursive: true });
            const orphanFile = join(orphanStagingDir, 'chunk.part');
            await writeFile(orphanFile, Buffer.from('orphan', 'utf8'));

            expect(await access(orphanFile).then(() => true).catch(() => false)).toBe(true);

            // Use a "future" nowMs relative to real filesystem mtimes so this test is deterministic.
            const nowMs = Date.now() + 10_000;
            await gcWorkspaceReplicationJobs({
                activeServerDir,
                nowMs,
                terminalTtlMs: 50,
            });

            await expect(access(orphanStagingDir)).rejects.toThrow();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('retains awaiting_recovery job records based on awaitingRecoveryAtMs (not updatedAtMs)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-awaiting-recovery-'));

        try {
            const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { gcWorkspaceReplicationJobs } = await import('./workspaceReplicationGc');

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await mkdir(paths.jobsDirectory, { recursive: true });

            const jobId = 'job_awaiting_recovery';
            const jobFilePath = join(paths.jobsDirectory, `${jobId}.json`);

            // Simulate a record where `updatedAtMs` does not reflect the awaiting-recovery transition.
            await writeFile(jobFilePath, JSON.stringify({
                schemaVersion: 1,
                jobId,
                correlationId: 'handoff_awaiting_recovery',
                createdAtMs: 0,
                updatedAtMs: 0,
                awaitingRecoveryAtMs: 150,
                lastErrorMessage: 'Needs manual recovery',
                status: {
                    status: 'awaiting_recovery',
                    phase: 'planning',
                    checkpoint: 'relationship_resolved',
                },
            }), 'utf8');

            const result = await gcWorkspaceReplicationJobs({
                activeServerDir,
                nowMs: 200,
                terminalTtlMs: 50,
            });

            expect(result.removedJobIds).toEqual([]);
            await expect(jobStore.read(jobId)).resolves.toMatchObject({
                jobId,
                awaitingRecoveryAtMs: 150,
                status: { status: 'awaiting_recovery' },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('removes unreferenced CAS blobs once they age past the retention window while keeping baseline-referenced blobs', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-cas-'));

        try {
            const {
                createWorkspaceReplicationPaths,
                resolveWorkspaceReplicationCasBlobPath,
            } = await import('./workspaceReplicationPaths');
            const { gcWorkspaceReplicationCas } = await import('./workspaceReplicationGc');

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(join(paths.casDirectory, 'sha256'), { recursive: true });

            const keepHex = 'a'.repeat(64);
            const dropHex = 'b'.repeat(64);
            const keepDigest = `sha256:${keepHex}`;
            const dropDigest = `sha256:${dropHex}`;

            const keepPath = resolveWorkspaceReplicationCasBlobPath({ casDirectory: paths.casDirectory, digest: keepDigest });
            const dropPath = resolveWorkspaceReplicationCasBlobPath({ casDirectory: paths.casDirectory, digest: dropDigest });
            await mkdir(join(paths.casDirectory, 'sha256'), { recursive: true });
            await mkdir(dirname(keepPath), { recursive: true });
            await mkdir(dirname(dropPath), { recursive: true });
            await writeFile(keepPath, Buffer.from('keep', 'utf8'));
            await writeFile(dropPath, Buffer.from('drop', 'utf8'));

            const nowMs = 10_000;
            await utimes(dropPath, (nowMs - 9_000) / 1000, (nowMs - 9_000) / 1000);

            // Create a baseline that references only the keep digest.
            const baselineDir = join(paths.relationshipsDirectory, 'rel_test', 'directionalBaselines', 'dir_test');
            await mkdir(baselineDir, { recursive: true });
            await writeFile(join(baselineDir, 'baseline.json'), JSON.stringify({
                schemaVersion: 1,
                cacheKey: `workspace-replication-baseline-v1-${'c'.repeat(64)}`,
                scope: {
                    sourceMachineId: 'm1',
                    sourceWorkspaceRoot: '~/src',
                    targetMachineId: 'm2',
                    targetWorkspaceRoot: '~/dst',
                    mode: 'one_way_safe',
                },
                baseline: {
                    manifestFingerprint: 'sha256:fp',
                    manifest: {
                        entries: [
                            {
                                relativePath: 'README.md',
                                kind: 'file',
                                digest: keepDigest,
                                sizeBytes: 4,
                                executable: false,
                            },
                        ],
                        fingerprint: 'sha256:fp2',
                    },
                    savedAtMs: 1,
                },
            }), 'utf8');

            const result = await gcWorkspaceReplicationCas({
                activeServerDir,
                nowMs,
                unreferencedTtlMs: 500,
            });

            expect(result.skippedDueToActiveJobs).toBe(false);
            expect(result.removedDigests).toEqual([dropDigest]);
            await expect(import('node:fs/promises').then(({ access }) => access(dropPath))).rejects.toThrow();
            await expect(import('node:fs/promises').then(({ access }) => access(keepPath))).resolves.toBeUndefined();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('removes oldest unreferenced CAS blobs when total CAS size exceeds the max-bytes cap', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-gc-cas-cap-'));

        try {
            const {
                createWorkspaceReplicationPaths,
                resolveWorkspaceReplicationCasBlobPath,
            } = await import('./workspaceReplicationPaths');
            const { gcWorkspaceReplicationCas } = await import('./workspaceReplicationGc');
            const { access } = await import('node:fs/promises');

            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(join(paths.casDirectory, 'sha256'), { recursive: true });

            const hex1 = '1'.repeat(64);
            const hex2 = '2'.repeat(64);
            const hex3 = '3'.repeat(64);
            const d1 = `sha256:${hex1}`;
            const d2 = `sha256:${hex2}`;
            const d3 = `sha256:${hex3}`;

            const p1 = resolveWorkspaceReplicationCasBlobPath({ casDirectory: paths.casDirectory, digest: d1 });
            const p2 = resolveWorkspaceReplicationCasBlobPath({ casDirectory: paths.casDirectory, digest: d2 });
            const p3 = resolveWorkspaceReplicationCasBlobPath({ casDirectory: paths.casDirectory, digest: d3 });
            await mkdir(dirname(p1), { recursive: true });
            await mkdir(dirname(p2), { recursive: true });
            await mkdir(dirname(p3), { recursive: true });
            await writeFile(p1, Buffer.from('x'.repeat(10), 'utf8'));
            await writeFile(p2, Buffer.from('y'.repeat(10), 'utf8'));
            await writeFile(p3, Buffer.from('z'.repeat(10), 'utf8'));

            const nowMs = 20_000;
            await utimes(p1, (nowMs - 9_000) / 1000, (nowMs - 9_000) / 1000);
            await utimes(p2, (nowMs - 8_000) / 1000, (nowMs - 8_000) / 1000);
            await utimes(p3, (nowMs - 7_000) / 1000, (nowMs - 7_000) / 1000);

            const result = await gcWorkspaceReplicationCas({
                activeServerDir,
                nowMs,
                unreferencedTtlMs: 0,
                maxBytes: 15,
            });

            expect(result.skippedDueToActiveJobs).toBe(false);
            expect(result.removedDigests).toEqual([d1, d2]);

            await expect(access(p1)).rejects.toThrow();
            await expect(access(p2)).rejects.toThrow();
            await expect(access(p3)).resolves.toBeUndefined();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
