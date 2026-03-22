import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
                        legacyWholeBufferMaxBytes: 1024 * 1024,
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
});
