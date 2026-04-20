import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceReplicationBaselineStore } from '../../baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationCasStore } from '../../cas/workspaceReplicationCasStore';
import { createWorkspaceReplicationJobStore } from '../../jobs/workspaceReplicationJobStore';
import { createWorkspaceReplicationRelationshipStore } from '../../relationships/workspaceReplicationRelationshipStore';
import { createWorkspaceReplicationBlobPackPayloadSource } from '../../transport/blobPackPayloadSource';
import { readWorkspaceReplicationSourceOfferFromFile, writeWorkspaceReplicationSourceOfferToFile } from '../../transport/workspaceReplicationSourceOfferFileFormat';
import { executeWorkspaceReplicationJobWithLocalRuntime } from './localRuntime';

import type { WorkspaceReplicationSourceOffer } from '../../transport/createWorkspaceReplicationSourceOffer';

function sha256DigestOfString(value: string): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('executeWorkspaceReplicationJobWithLocalRuntime', () => {
    it('marks the job awaiting_recovery for one_way_safe sync_changes when the target workspace diverged on paths the source would overwrite', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-diverged-target-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-diverged-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-diverged-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-diverged-target-workspace-'));

        try {
            const { createWorkspaceReplicationBaselineStore } = await import('../../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationCasStore } = await import('../../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../../transport/blobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./localRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const baselineContents = 'baseline\n';
            const baselineDigest = sha256DigestOfString(baselineContents);
            const divergedContents = 'diverged\n';
            await writeFile(join(targetWorkspaceRoot, 'README.md'), divergedContents, 'utf8');

            const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
            await baselineStore.save({
                scope,
                baseline: {
                    manifestFingerprint: sha256DigestOfString('baseline-fp'),
                    manifest: {
                        entries: [
                            {
                                kind: 'file',
                                relativePath: 'README.md',
                                digest: baselineDigest,
                                sizeBytes: Buffer.byteLength(baselineContents),
                                executable: false,
                            },
                        ],
                        fingerprint: sha256DigestOfString('baseline-manifest-fp'),
                    },
                    savedAtMs: 1,
                },
            });

            const sourceContents = 'source\n';
            const sourceDigest = sha256DigestOfString(sourceContents);
            const sourceFilePath = join(sourceWorkspaceRoot, 'README.md');
            await writeFile(sourceFilePath, sourceContents, 'utf8');

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: sourceDigest,
                sourcePath: sourceFilePath,
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_diverged',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp'),
                manifest: {
                    entries: [
                        {
                            kind: 'file',
                            relativePath: 'README.md',
                            digest: sourceDigest,
                            sizeBytes: Buffer.byteLength(sourceContents),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-fp'),
                },
                blobIndex: [{ digest: sourceDigest, sizeBytes: Buffer.byteLength(sourceContents) }],
            };

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-diverged-offer-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_diverged_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                offerId: offer.offerId,
                mode: 'one_way_safe',
                correlationId: 'corr_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'pending',
                    phase: 'negotiate_missing_digests',
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

            const requestBlobPackToFile = vi.fn(async ({ packId, digests, destinationPath }) => {
                const payloadSource = await createWorkspaceReplicationBlobPackPayloadSource({
                    activeServerDir: sourceActiveServerDir,
                    packId,
                    digests,
                });
                if (payloadSource.kind !== 'file') {
                    throw new Error('expected file payload source');
                }
                await copyFile(payloadSource.filePath, destinationPath);
                await payloadSource.dispose?.();
            });

            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_diverged_1',
                now: () => 42,
                relationshipScope: scope,
                resolveSourceOfferById: async () => {
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_diverged',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile,
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'sync_changes',
                    conflictPolicy: 'create_sibling_copy',
                },
            });

            expect(result.status).toMatchObject({
                status: 'awaiting_recovery',
                phase: 'planning',
                checkpoint: 'relationship_resolved',
            });
            expect(result.status.blockingDivergenceCandidates.length).toBeGreaterThan(0);
            expect(requestBlobPackToFile).not.toHaveBeenCalled();

            await expect(jobStore.read('job_diverged_1')).resolves.toMatchObject({
                jobId: 'job_diverged_1',
                awaitingRecoveryAtMs: 42,
                status: {
                    status: 'awaiting_recovery',
                    checkpoint: 'relationship_resolved',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('does not false-diverge on administrative paths when the source offer manifest intentionally includes them', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-admin-paths-target-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-admin-paths-target-workspace-'));

        try {
            const { createWorkspaceReplicationBaselineStore } = await import('../../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationJobStore } = await import('../../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../../relationships/workspaceReplicationRelationshipStore');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./localRuntime');

            await mkdir(join(targetWorkspaceRoot, '.git', 'refs'), { recursive: true });
            await writeFile(join(targetWorkspaceRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
            await writeFile(join(targetWorkspaceRoot, '.git', 'refs', 'main'), 'abc123\n', 'utf8');
            await writeFile(join(targetWorkspaceRoot, 'README.md'), 'hello\n', 'utf8');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot: '/source',
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_admin_paths_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_admin_paths_1',
                sourceFingerprint: sha256DigestOfString('offer-admin-paths'),
                manifest: {
                    entries: [
                        {
                            kind: 'directory',
                            relativePath: '.git',
                        },
                        {
                            kind: 'file',
                            relativePath: '.git/HEAD',
                            digest: sha256DigestOfString('ref: refs/heads/main\n'),
                            sizeBytes: Buffer.byteLength('ref: refs/heads/main\n'),
                            executable: false,
                        },
                        {
                            kind: 'directory',
                            relativePath: '.git/refs',
                        },
                        {
                            kind: 'file',
                            relativePath: '.git/refs/main',
                            digest: sha256DigestOfString('abc123\n'),
                            sizeBytes: Buffer.byteLength('abc123\n'),
                            executable: false,
                        },
                        {
                            kind: 'file',
                            relativePath: 'README.md',
                            digest: sha256DigestOfString('hello\n'),
                            sizeBytes: Buffer.byteLength('hello\n'),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-admin-paths'),
                },
                blobIndex: [],
            };

            const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
            await baselineStore.save({
                scope,
                baseline: {
                    manifestFingerprint: offer.manifest.fingerprint!,
                    manifest: offer.manifest,
                    savedAtMs: 1,
                },
            });

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-admin-paths-offer-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_admin_paths_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_admin_paths_1',
                offerId: offer.offerId,
                mode: 'one_way_safe',
                correlationId: 'corr_admin_paths_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'pending',
                    phase: 'negotiate_missing_digests',
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

            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_admin_paths_1',
                now: () => 42,
                relationshipScope: scope,
                resolveSourceOfferById: async () => {
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_admin_paths_1',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile: vi.fn(async () => undefined),
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(result.status).toMatchObject({
                status: 'completed',
                checkpoint: 'baseline_committed',
            });
            expect(result.status.blockingDivergenceCandidates).toEqual([]);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('marks the job awaiting_recovery when a one_way_safe sync_changes target diverges after the initial safety check (no overwrite after mid-transfer edits)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-midtransfer-divergence-target-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-midtransfer-divergence-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-midtransfer-divergence-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-midtransfer-divergence-target-workspace-'));

        try {
            const { createWorkspaceReplicationBaselineStore } = await import('../../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationCasStore } = await import('../../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../../transport/blobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./localRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const baselineContents = 'baseline\n';
            const baselineDigest = sha256DigestOfString(baselineContents);
            const targetReadmePath = join(targetWorkspaceRoot, 'README.md');
            await writeFile(targetReadmePath, baselineContents, 'utf8');

            const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
            await baselineStore.save({
                scope,
                baseline: {
                    manifestFingerprint: sha256DigestOfString('baseline-fp'),
                    manifest: {
                        entries: [
                            {
                                kind: 'file',
                                relativePath: 'README.md',
                                digest: baselineDigest,
                                sizeBytes: Buffer.byteLength(baselineContents),
                                executable: false,
                            },
                        ],
                        fingerprint: sha256DigestOfString('baseline-manifest-fp'),
                    },
                    savedAtMs: 1,
                },
            });

            const sourceContents = 'source\n';
            const sourceDigest = sha256DigestOfString(sourceContents);
            const sourceFilePath = join(sourceWorkspaceRoot, 'README.md');
            await writeFile(sourceFilePath, sourceContents, 'utf8');

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: sourceDigest,
                sourcePath: sourceFilePath,
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_midtransfer_divergence',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp'),
                manifest: {
                    entries: [
                        {
                            kind: 'file',
                            relativePath: 'README.md',
                            digest: sourceDigest,
                            sizeBytes: Buffer.byteLength(sourceContents),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-fp'),
                },
                blobIndex: [{ digest: sourceDigest, sizeBytes: Buffer.byteLength(sourceContents) }],
            };

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-midtransfer-divergence-offer-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_midtransfer_divergence_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                offerId: offer.offerId,
                mode: 'one_way_safe',
                correlationId: 'corr_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'pending',
                    phase: 'negotiate_missing_digests',
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

            let mutated = false;
            const requestBlobPackToFile = vi.fn(async ({ packId, digests, destinationPath }) => {
                if (!mutated) {
                    mutated = true;
                    await writeFile(targetReadmePath, 'diverged\n', 'utf8');
                }
                const payloadSource = await createWorkspaceReplicationBlobPackPayloadSource({
                    activeServerDir: sourceActiveServerDir,
                    packId,
                    digests,
                });
                if (payloadSource.kind !== 'file') {
                    throw new Error('expected file payload source');
                }
                await copyFile(payloadSource.filePath, destinationPath);
                await payloadSource.dispose?.();
            });

            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_midtransfer_divergence_1',
                now: () => 42,
                relationshipScope: scope,
                resolveSourceOfferById: async () => {
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_midtransfer_divergence',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile,
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(mutated).toBe(true);
            expect(requestBlobPackToFile).toHaveBeenCalled();
            expect(result.status.status).toBe('awaiting_recovery');
            await expect(readFile(targetReadmePath, 'utf8')).resolves.toBe('diverged\n');
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('does not block one_way_safe sync_changes when the target diverged only on paths the source would not overwrite', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-nonblocking-divergence-target-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-nonblocking-divergence-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-nonblocking-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-nonblocking-target-workspace-'));

        try {
            const { createWorkspaceReplicationBaselineStore } = await import('../../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationCasStore } = await import('../../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../../transport/blobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./localRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const baselineReadmeContents = 'baseline readme\n';
            const baselineReadmeDigest = sha256DigestOfString(baselineReadmeContents);
            const baselineNotesContents = 'baseline notes\n';
            const baselineNotesDigest = sha256DigestOfString(baselineNotesContents);

            const divergedNotesContents = 'diverged notes\n';
            const divergedNotesDigest = sha256DigestOfString(divergedNotesContents);
            await writeFile(join(targetWorkspaceRoot, 'README.md'), baselineReadmeContents, 'utf8');
            await writeFile(join(targetWorkspaceRoot, 'notes.txt'), divergedNotesContents, 'utf8');

            const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
            await baselineStore.save({
                scope,
                baseline: {
                    manifestFingerprint: sha256DigestOfString('baseline-fp'),
                    manifest: {
                        entries: [
                            {
                                kind: 'file',
                                relativePath: 'README.md',
                                digest: baselineReadmeDigest,
                                sizeBytes: Buffer.byteLength(baselineReadmeContents),
                                executable: false,
                            },
                            {
                                kind: 'file',
                                relativePath: 'notes.txt',
                                digest: baselineNotesDigest,
                                sizeBytes: Buffer.byteLength(baselineNotesContents),
                                executable: false,
                            },
                        ],
                        fingerprint: sha256DigestOfString('baseline-manifest-fp'),
                    },
                    savedAtMs: 1,
                },
            });

            const sourceReadmeContents = baselineReadmeContents;
            const sourceReadmeDigest = baselineReadmeDigest;
            const sourceFilePath = join(sourceWorkspaceRoot, 'README.md');
            await writeFile(sourceFilePath, sourceReadmeContents, 'utf8');
            const sourceNotesPath = join(sourceWorkspaceRoot, 'notes.txt');
            await writeFile(sourceNotesPath, divergedNotesContents, 'utf8');

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: sourceReadmeDigest,
                sourcePath: sourceFilePath,
            });
            await sourceCas.commitFile({
                digest: divergedNotesDigest,
                sourcePath: sourceNotesPath,
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_nonblocking_divergence',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp'),
                manifest: {
                    entries: [
                        {
                            kind: 'file',
                            relativePath: 'README.md',
                            digest: sourceReadmeDigest,
                            sizeBytes: Buffer.byteLength(sourceReadmeContents),
                            executable: false,
                        },
                        {
                            kind: 'file',
                            relativePath: 'notes.txt',
                            digest: divergedNotesDigest,
                            sizeBytes: Buffer.byteLength(divergedNotesContents),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-fp'),
                },
                blobIndex: [
                    { digest: sourceReadmeDigest, sizeBytes: Buffer.byteLength(sourceReadmeContents) },
                    { digest: divergedNotesDigest, sizeBytes: Buffer.byteLength(divergedNotesContents) },
                ],
            };

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-nonblocking-offer-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_nonblocking_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                offerId: offer.offerId,
                mode: 'one_way_safe',
                correlationId: 'corr_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'pending',
                    phase: 'negotiate_missing_digests',
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

            const requestBlobPackToFile = vi.fn(async ({ packId, digests, destinationPath }) => {
                const payloadSource = await createWorkspaceReplicationBlobPackPayloadSource({
                    activeServerDir: sourceActiveServerDir,
                    packId,
                    digests,
                });
                if (payloadSource.kind !== 'file') {
                    throw new Error('expected file payload source');
                }
                await copyFile(payloadSource.filePath, destinationPath);
                await payloadSource.dispose?.();
            });

            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_nonblocking_1',
                now: () => 42,
                relationshipScope: scope,
                resolveSourceOfferById: async () => {
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_nonblocking',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile,
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(result.status.status).toBe('completed');
            await expect(jobStore.read('job_nonblocking_1')).resolves.toMatchObject({
                jobId: 'job_nonblocking_1',
                completedAtMs: 42,
                status: {
                    status: 'completed',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('does not treat git administrative paths as target divergence when the source manifest includes them', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-git-admin-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-git-admin-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-git-admin-target-workspace-'));

        try {
            const { createWorkspaceReplicationBaselineStore } = await import('../../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationJobStore } = await import('../../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../../relationships/workspaceReplicationRelationshipStore');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./localRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const gitHeadContents = 'ref: refs/heads/main\n';
            const gitHeadDigest = sha256DigestOfString(gitHeadContents);
            const readmeContents = 'baseline\n';
            const readmeDigest = sha256DigestOfString(readmeContents);

            await mkdir(join(sourceWorkspaceRoot, '.git'), { recursive: true });
            await mkdir(join(targetWorkspaceRoot, '.git'), { recursive: true });
            await writeFile(join(sourceWorkspaceRoot, '.git', 'HEAD'), gitHeadContents, 'utf8');
            await writeFile(join(targetWorkspaceRoot, '.git', 'HEAD'), gitHeadContents, 'utf8');
            await writeFile(join(sourceWorkspaceRoot, 'README.md'), readmeContents, 'utf8');
            await writeFile(join(targetWorkspaceRoot, 'README.md'), readmeContents, 'utf8');

            const manifest = {
                entries: [
                    { kind: 'directory', relativePath: '.git' } as const,
                    {
                        kind: 'file',
                        relativePath: '.git/HEAD',
                        digest: gitHeadDigest,
                        sizeBytes: Buffer.byteLength(gitHeadContents),
                        executable: false,
                    } as const,
                    {
                        kind: 'file',
                        relativePath: 'README.md',
                        digest: readmeDigest,
                        sizeBytes: Buffer.byteLength(readmeContents),
                        executable: false,
                    } as const,
                ],
                fingerprint: sha256DigestOfString('git-admin-manifest'),
            };

            const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
            await baselineStore.save({
                scope,
                baseline: {
                    manifestFingerprint: manifest.fingerprint,
                    manifest,
                    savedAtMs: 1,
                },
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_git_admin',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_git_admin',
                sourceFingerprint: manifest.fingerprint,
                manifest,
                blobIndex: [
                    { digest: gitHeadDigest, sizeBytes: Buffer.byteLength(gitHeadContents) },
                    { digest: readmeDigest, sizeBytes: Buffer.byteLength(readmeContents) },
                ],
            };

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-git-admin-offer-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_git_admin_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_git_admin',
                offerId: offer.offerId,
                mode: 'one_way_safe',
                correlationId: 'corr_git_admin_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'pending',
                    phase: 'negotiate_missing_digests',
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

            const requestBlobPackToFile = vi.fn(async () => undefined);
            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_git_admin_1',
                now: () => 42,
                relationshipScope: scope,
                resolveSourceOfferById: async () => {
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_git_admin',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile,
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(result.status.status).toBe('completed');
            expect(result.status.blockingDivergenceCandidates).toEqual([]);
            expect(requestBlobPackToFile).not.toHaveBeenCalled();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('marks the job awaiting_recovery for one_way_safe sync_changes when the baseline is missing', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-missing-baseline-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-missing-baseline-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-missing-baseline-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-missing-baseline-target-workspace-'));

        try {
            const { createWorkspaceReplicationCasStore } = await import('../../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../../transport/blobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./localRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const sourceContents = 'source\n';
            const sourceDigest = sha256DigestOfString(sourceContents);
            const sourceFilePath = join(sourceWorkspaceRoot, 'README.md');
            await writeFile(sourceFilePath, sourceContents, 'utf8');

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: sourceDigest,
                sourcePath: sourceFilePath,
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_missing_baseline',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp'),
                manifest: {
                    entries: [
                        {
                            kind: 'file',
                            relativePath: 'README.md',
                            digest: sourceDigest,
                            sizeBytes: Buffer.byteLength(sourceContents),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-fp'),
                },
                blobIndex: [{ digest: sourceDigest, sizeBytes: Buffer.byteLength(sourceContents) }],
            };

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-missing-baseline-offer-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_missing_baseline_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                offerId: offer.offerId,
                mode: 'one_way_safe',
                correlationId: 'corr_1',
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'pending',
                    phase: 'negotiate_missing_digests',
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

            const requestBlobPackToFile = vi.fn(async ({ packId, digests, destinationPath }) => {
                const payloadSource = await createWorkspaceReplicationBlobPackPayloadSource({
                    activeServerDir: sourceActiveServerDir,
                    packId,
                    digests,
                });
                if (payloadSource.kind !== 'file') {
                    throw new Error('expected file payload source');
                }
                await copyFile(payloadSource.filePath, destinationPath);
                await payloadSource.dispose?.();
            });

            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_missing_baseline_1',
                now: () => 42,
                relationshipScope: scope,
                resolveSourceOfferById: async () => {
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_missing_baseline',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile,
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(result.status).toMatchObject({
                status: 'awaiting_recovery',
                phase: 'planning',
                checkpoint: 'relationship_resolved',
            });
            expect(requestBlobPackToFile).not.toHaveBeenCalled();

            await expect(jobStore.read('job_missing_baseline_1')).resolves.toMatchObject({
                jobId: 'job_missing_baseline_1',
                awaitingRecoveryAtMs: 42,
                status: {
                    status: 'awaiting_recovery',
                    checkpoint: 'relationship_resolved',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });
});
