import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';

function sha256DigestOfString(value: string): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('executeWorkspaceReplicationJobWithLocalRuntime', () => {
    it('runs a job using real blob-pack receive + apply helpers (end-to-end)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-target-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-target-workspace-'));

        try {
            const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const fileContents = 'hello workspace replication\n';
            const fileDigest = sha256DigestOfString(fileContents);
            const sourceFilePath = join(sourceWorkspaceRoot, 'README.md');
            await writeFile(sourceFilePath, fileContents, 'utf8');

            // Seed the source CAS with the blob so we can synthesize a blob-pack file from it.
            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: fileDigest,
                sourcePath: sourceFilePath,
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp'),
                manifest: {
                    entries: [
                        {
                            kind: 'file',
                            relativePath: 'README.md',
                            digest: fileDigest,
                            sizeBytes: Buffer.byteLength(fileContents),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-fp'),
                },
                blobIndex: [{ digest: fileDigest, sizeBytes: Buffer.byteLength(fileContents) }],
            };

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-offer-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_1',
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

            const now = vi.fn(() => 42);
            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_1',
                now,
                relationshipScope: scope,
                resolveSourceOfferById: async (offerId) => {
                    expect(offerId).toBe('offer_1');
                    // Use the real streaming offer decode path.
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_1',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile: async ({ packId, digests, destinationPath }) => {
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
                },
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'transfer_snapshot',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(result.status.status).toBe('completed');
            expect(result).toMatchObject({
                result: {
                    targetPath: targetWorkspaceRoot,
                },
            });
            expect(result.status.progressCounters).toMatchObject({
                plannedFiles: 1,
                plannedBytes: Buffer.byteLength(fileContents),
                transferredFiles: 1,
                transferredBytes: Buffer.byteLength(fileContents),
                appliedFiles: 1,
                appliedBytes: Buffer.byteLength(fileContents),
            });

            await expect(jobStore.read('job_1')).resolves.toMatchObject({
                jobId: 'job_1',
                completedAtMs: 42,
                status: {
                    status: 'completed',
                    checkpoint: 'baseline_committed',
                },
            });

            const written = await import('node:fs/promises').then(async ({ readFile }) =>
                await readFile(join(targetWorkspaceRoot, 'README.md'), 'utf8'),
            );
            expect(written).toBe(fileContents);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('persists transferred progress counters during blob-pack transfer (per-pack)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-target-progress-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-source-progress-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-source-workspace-progress-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-target-workspace-progress-'));

        try {
            const originalBlobPackTargetBytes = process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES;
            // Keep the test fast by forcing small pack boundaries instead of creating hundreds of blobs.
            process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = '1';
            const configMod = await import('@/configuration');
            configMod.reloadConfiguration();

            try {
                const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
                const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
                const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
                const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
                const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
                const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            const fileEntries: WorkspaceReplicationSourceOffer['manifest']['entries'] = [];
            const blobIndex: Array<WorkspaceReplicationSourceOffer['blobIndex'][number]> = [];
            let totalBytes = 0;

            // Force >1 blob pack by configuring a tiny target-bytes cap (above).
            await mkdir(join(sourceWorkspaceRoot, 'files'), { recursive: true });
            fileEntries.push({
                kind: 'directory',
                relativePath: 'files',
            });
            const blobCount = 3;
            for (let i = 0; i < blobCount; i += 1) {
                const contents = `blob-${i}\n`;
                const digest = sha256DigestOfString(contents);
                const relPath = `files/file-${i}.txt`;
                const sourcePath = join(sourceWorkspaceRoot, relPath);
                await writeFile(sourcePath, contents, 'utf8');
                await sourceCas.commitFile({ digest, sourcePath });

                const sizeBytes = Buffer.byteLength(contents);
                totalBytes += sizeBytes;
                fileEntries.push({
                    kind: 'file',
                    relativePath: relPath,
                    digest,
                    sizeBytes,
                    executable: false,
                });
                blobIndex.push({ digest, sizeBytes });
            }

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_progress_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_progress_1',
                sourceFingerprint: sha256DigestOfString('offer-progress-fp'),
                manifest: {
                    entries: fileEntries,
                    fingerprint: sha256DigestOfString('manifest-progress-fp'),
                },
                blobIndex,
            };

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-offer-progress-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_progress_1',
                relationshipId: relationship.relationshipId,
                directionId: offer.directionId,
                offerId: offer.offerId,
                mode: 'one_way_safe',
                correlationId: 'corr_progress_1',
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

            let observedTransferredBytesDuringTransfer = 0;
            let requestCount = 0;

            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_progress_1',
                now: () => 42,
                relationshipScope: scope,
                resolveSourceOfferById: async () => {
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_progress_1',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile: async ({ packId, digests, destinationPath }) => {
                    requestCount += 1;

                    // By the time we request the 2nd pack, the 1st pack has already been received
                    // into CAS. The job record should reflect that progress (not wait until the end).
                    if (requestCount === 2) {
                        const midTransfer = await jobStore.read('job_progress_1');
                        observedTransferredBytesDuringTransfer = midTransfer?.status.progressCounters.transferredBytes ?? 0;
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
                },
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'transfer_snapshot',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(requestCount).toBeGreaterThanOrEqual(2);
            expect(observedTransferredBytesDuringTransfer).toBeGreaterThan(0);
            expect(result.status.status).toBe('completed');
                expect(result.status.progressCounters).toMatchObject({
                    plannedFiles: blobCount,
                    plannedBytes: totalBytes,
                    transferredFiles: blobCount,
                    transferredBytes: totalBytes,
                });
            } finally {
                process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = originalBlobPackTargetBytes;
                configMod.reloadConfiguration();
            }
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('applies sync_changes using the real current target manifest so removed paths are actually removed', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-target-sync-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-source-sync-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-source-workspace-sync-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-target-workspace-sync-'));

        try {
            const { createWorkspaceReplicationBaselineStore } = await import('../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const fileContents = 'hello workspace replication (sync changes)\n';
            const fileDigest = sha256DigestOfString(fileContents);
            const sourceFilePath = join(sourceWorkspaceRoot, 'README.md');
            await writeFile(sourceFilePath, fileContents, 'utf8');

            const deleteMeContents = 'remove me';
            const deleteMeDigest = sha256DigestOfString(deleteMeContents);
            await writeFile(join(targetWorkspaceRoot, 'DELETE_ME.txt'), deleteMeContents, 'utf8');

            const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
            await baselineStore.save({
                scope,
                baseline: {
                    manifestFingerprint: sha256DigestOfString('baseline-fp'),
                    manifest: {
                        entries: [
                            {
                                kind: 'file',
                                relativePath: 'DELETE_ME.txt',
                                digest: deleteMeDigest,
                                sizeBytes: Buffer.byteLength(deleteMeContents),
                                executable: false,
                            },
                        ],
                        fingerprint: sha256DigestOfString('baseline-manifest-fp'),
                    },
                    savedAtMs: 1,
                },
            });

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: fileDigest,
                sourcePath: sourceFilePath,
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp'),
                manifest: {
                    entries: [
                        {
                            kind: 'file',
                            relativePath: 'README.md',
                            digest: fileDigest,
                            sizeBytes: Buffer.byteLength(fileContents),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-fp'),
                },
                blobIndex: [{ digest: fileDigest, sizeBytes: Buffer.byteLength(fileContents) }],
            };

            const offerTempDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-offer-sync-'));
            const offerPath = join(offerTempDir, 'source-offer.txt');
            await writeWorkspaceReplicationSourceOfferToFile({
                offer,
                filePath: offerPath,
            });

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_1',
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

            const now = vi.fn(() => 42);
            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_1',
                now,
                relationshipScope: scope,
                resolveSourceOfferById: async (offerId) => {
                    expect(offerId).toBe('offer_1');
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
                    return await readWorkspaceReplicationSourceOfferFromFile({
                        transferId: 'offer_transfer_1',
                        filePath: offerPath,
                    });
                },
                requestBlobPackToFile: async ({ packId, digests, destinationPath }) => {
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
                },
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                },
            });

            const appliedTargetPath = result.result?.targetPath ?? targetWorkspaceRoot;
            await expect(access(join(appliedTargetPath, 'DELETE_ME.txt'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('aborts before receiving a blob pack when cancellation is requested after the pack download completes', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-cancel-after-download-target-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-cancel-after-download-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-cancel-after-download-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-cancel-after-download-target-workspace-'));

        try {
            const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const fileContents = 'hello cancel after download\n';
            const fileDigest = sha256DigestOfString(fileContents);
            const sourceFilePath = join(sourceWorkspaceRoot, 'README.md');
            await writeFile(sourceFilePath, fileContents, 'utf8');

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: fileDigest,
                sourcePath: sourceFilePath,
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_cancel_after_download',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp-cancel'),
                manifest: {
                    entries: [
                        {
                            kind: 'file',
                            relativePath: 'README.md',
                            digest: fileDigest,
                            sizeBytes: Buffer.byteLength(fileContents),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-fp-cancel'),
                },
                blobIndex: [{ digest: fileDigest, sizeBytes: Buffer.byteLength(fileContents) }],
            };

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_cancel_after_download_1',
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

            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_cancel_after_download_1',
                now: () => 99,
                relationshipScope: scope,
                resolveSourceOfferById: async () => offer,
                requestBlobPackToFile: async ({ packId, digests, destinationPath }) => {
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

                    await jobStore.update('job_cancel_after_download_1', (current) => ({
                        ...current,
                        cancelRequestedAtMs: 50,
                    }));
                },
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'transfer_snapshot',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(result.status.status).toBe('aborted');

            const targetCas = createWorkspaceReplicationCasStore({ activeServerDir });
            await expect(targetCas.contains(fileDigest)).resolves.toBe(false);

            await expect(access(join(targetWorkspaceRoot, 'README.md'))).rejects.toThrow();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('aborts when cancellation is requested mid-transfer (between blob packs)', async () => {
        const previousTargetBytes = process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES;
        process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = '1';
        vi.resetModules();

        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-cancel-target-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-cancel-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-cancel-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-cancel-target-workspace-'));

        try {
            const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);

            const file1Contents = 'first\n';
            const file2Contents = 'second\n';
            const file1Digest = sha256DigestOfString(file1Contents);
            const file2Digest = sha256DigestOfString(file2Contents);
            await writeFile(join(sourceWorkspaceRoot, 'a.txt'), file1Contents, 'utf8');
            await writeFile(join(sourceWorkspaceRoot, 'b.txt'), file2Contents, 'utf8');

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: file1Digest,
                sourcePath: join(sourceWorkspaceRoot, 'a.txt'),
            });
            await sourceCas.commitFile({
                digest: file2Digest,
                sourcePath: join(sourceWorkspaceRoot, 'b.txt'),
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_cancel_1',
                relationshipId: relationship.relationshipId,
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp'),
                manifest: {
                    entries: [
                        {
                            kind: 'file',
                            relativePath: 'a.txt',
                            digest: file1Digest,
                            sizeBytes: Buffer.byteLength(file1Contents),
                            executable: false,
                        },
                        {
                            kind: 'file',
                            relativePath: 'b.txt',
                            digest: file2Digest,
                            sizeBytes: Buffer.byteLength(file2Contents),
                            executable: false,
                        },
                    ],
                    fingerprint: sha256DigestOfString('manifest-fp'),
                },
                blobIndex: [
                    { digest: file1Digest, sizeBytes: Buffer.byteLength(file1Contents) },
                    { digest: file2Digest, sizeBytes: Buffer.byteLength(file2Contents) },
                ],
            };

            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_cancel_1',
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

            let packRequests = 0;
            const result = await executeWorkspaceReplicationJobWithLocalRuntime({
                activeServerDir,
                jobStore,
                relationships,
                jobId: 'job_cancel_1',
                now: () => 99,
                relationshipScope: scope,
                resolveSourceOfferById: async () => offer,
                requestBlobPackToFile: async ({ packId, digests, destinationPath }) => {
                    packRequests += 1;
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

                    // Cancel after the first pack completes. The runner must notice this before
                    // attempting the next pack and abort the job (not fail it).
                    if (packRequests === 1) {
                        await jobStore.update('job_cancel_1', (current) => ({
                            ...current,
                            cancelRequestedAtMs: 50,
                        }));
                    }
                },
                apply: {
                    targetPath: targetWorkspaceRoot,
                    strategy: 'transfer_snapshot',
                    conflictPolicy: 'replace_existing',
                },
            });

            expect(packRequests).toBe(1);
            expect(result.status.status).toBe('aborted');
        } finally {
            if (previousTargetBytes === undefined) {
                delete process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES;
            } else {
                process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = previousTargetBytes;
            }
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('marks the job awaiting_recovery for one_way_safe sync_changes when the target workspace diverged on paths the source would overwrite', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-diverged-target-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-job-runner-diverged-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-diverged-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-replication-job-diverged-target-workspace-'));

        try {
            const { createWorkspaceReplicationBaselineStore } = await import('../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

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
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
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
            const { createWorkspaceReplicationBaselineStore } = await import('../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

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
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
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
            const { createWorkspaceReplicationBaselineStore } = await import('../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

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
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
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
            const { createWorkspaceReplicationBaselineStore } = await import('../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

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
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
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
            const { createWorkspaceReplicationBaselineStore } = await import('../baseline/workspaceReplicationBaselineStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

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
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
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
            const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('../jobs/workspaceReplicationJobStore');
            const { createWorkspaceReplicationRelationshipStore } = await import('../relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('../transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { writeWorkspaceReplicationSourceOfferToFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
            const { executeWorkspaceReplicationJobWithLocalRuntime } = await import('./executeWorkspaceReplicationJobWithLocalRuntime');

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
                    const { readWorkspaceReplicationSourceOfferFromFile } = await import('../transport/workspaceReplicationSourceOfferFileFormat');
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
