import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TransferPayloadFileResult } from '@/machines/transfer/transferPayloadFileSink';
import type { WorkspaceReplicationSourceOffer } from '@/workspaces/replication/transport/createWorkspaceReplicationSourceOffer';
import type { WorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';

function sha256DigestOfString(value: string): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('resumeWorkspaceReplicationJobsAfterRestart', () => {
    it('leaves restart-recovered session-handoff workspace replication jobs awaiting recovery', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-daemon-resume-replication-target-'));
        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-daemon-resume-replication-source-'));
        const sourceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-daemon-resume-replication-source-workspace-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-daemon-resume-replication-target-workspace-'));

        try {
            const { createWorkspaceReplicationCasStore } = await import('@/workspaces/replication/cas/workspaceReplicationCasStore');
            const { createWorkspaceReplicationJobStore } = await import('@/workspaces/replication/jobs/workspaceReplicationJobStore');
            const {
                buildWorkspaceReplicationDirectionId,
                createWorkspaceReplicationRelationshipStore,
            } = await import('@/workspaces/replication/relationships/workspaceReplicationRelationshipStore');
            const { createWorkspaceReplicationSourceOfferStore } = await import('@/workspaces/replication/transport/workspaceReplicationSourceOfferStore');
            const { createWorkspaceReplicationBlobPackPayloadSource } = await import('@/workspaces/replication/transport/createWorkspaceReplicationBlobPackPayloadSource');
            const { buildSessionHandoffWorkspaceBlobPackTransferId } = await import(
                '@/session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationServerRouted',
            );
            const { resumeWorkspaceReplicationJobsAfterRestart } = await import('./resumeWorkspaceReplicationJobsAfterRestart');

            const relationships = createWorkspaceReplicationRelationshipStore({ activeServerDir });
            const scope = {
                sourceMachineId: 'machine-source',
                sourceWorkspaceRoot,
                targetMachineId: 'machine-target',
                targetWorkspaceRoot,
                mode: 'one_way_safe' as const,
            };
            const relationship = await relationships.ensureRelationship(scope);
            const directionId = buildWorkspaceReplicationDirectionId(scope);

            const fileContents = 'hello from restart recovery\n';
            const fileDigest = sha256DigestOfString(fileContents);
            await writeFile(join(sourceWorkspaceRoot, 'README.md'), fileContents, 'utf8');

            const sourceCas = createWorkspaceReplicationCasStore({ activeServerDir: sourceActiveServerDir });
            await sourceCas.commitFile({
                digest: fileDigest,
                sourcePath: join(sourceWorkspaceRoot, 'README.md'),
            });

            const offer: WorkspaceReplicationSourceOffer = {
                offerId: 'offer_resume_1',
                relationshipId: relationship.relationshipId,
                directionId,
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

            const sourceOfferStore = createWorkspaceReplicationSourceOfferStore({ activeServerDir });
            await sourceOfferStore.write(offer);

            const handoffId = 'handoff_resume_1';
            const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
            await jobStore.write({
                schemaVersion: 1,
                jobId: 'job_resume_1',
                relationshipId: relationship.relationshipId,
                directionId,
                offerId: offer.offerId,
                mode: 'one_way_safe',
                correlationId: `session_handoff_workspace_prepare_target:${handoffId}`,
                resumeContext: {
                    apply: {
                        targetPath: targetWorkspaceRoot,
                        strategy: 'transfer_snapshot',
                        conflictPolicy: 'replace_existing',
                    },
                },
                createdAtMs: 10,
                updatedAtMs: 10,
                status: {
                    status: 'pending',
                    phase: 'transfer_missing_blobs_to_target_cas',
                    checkpoint: 'relationship_resolved',
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

            const transfers = {
                requestDirectPeerSourceOffer: async () => {
                    throw new Error('direct peer not supported in test');
                },
                requestServerRoutedSourceOffer: async () => {
                    throw new Error('server-routed offer not supported in test');
                },
                publishDirectPeerBlobPack: () => [],
                requestDirectPeerBlobPackToFile: async () => {
                    throw new Error('direct peer not supported in test');
                },
                requestServerRoutedBlobPackToFile: async (input) => {
                    const { transferId, sourceMachineId, destinationPath, openBody } = input;
                    expect(sourceMachineId).toBe('machine-source');
                    expect(openBody).toEqual({
                        t: 'workspace_replication_blob_pack_v1',
                        packId: expect.any(String),
                        digests: expect.any(Array),
                    });
                    const body = openBody as { t: string; packId: string; digests: string[] };
                    expect(transferId).toBe(buildSessionHandoffWorkspaceBlobPackTransferId({
                        handoffId,
                        packId: body.packId,
                    }));

                    const payloadSource = await createWorkspaceReplicationBlobPackPayloadSource({
                        activeServerDir: sourceActiveServerDir,
                        packId: body.packId,
                        digests: body.digests,
                    });
                    if (payloadSource.kind !== 'file') {
                        throw new Error('expected file payload source');
                    }
                    if (typeof payloadSource.sizeBytes !== 'number' || typeof payloadSource.manifestHash !== 'string') {
                        throw new Error('expected file payload source metadata');
                    }
                    await copyFile(payloadSource.filePath, destinationPath);
                    await payloadSource.dispose?.();

                    return {
                        destinationPath,
                        sizeBytes: payloadSource.sizeBytes,
                        manifestHash: payloadSource.manifestHash,
                    } satisfies TransferPayloadFileResult;
                },
            } satisfies WorkspaceReplicationTransfers;

            await resumeWorkspaceReplicationJobsAfterRestart({
                activeServerDir,
                localMachineId: 'machine-target',
                machineTransferChannel: {
                    onEnvelope: () => () => {},
                    sendEnvelope: () => {},
                },
                transfers,
            });

            const recovered = await jobStore.read('job_resume_1');
            expect(recovered?.status.status).toBe('awaiting_recovery');
            expect(recovered?.status.warnings).toContain('recovered_after_daemon_restart');
            expect(String(recovered?.lastErrorMessage ?? '').toLowerCase()).toContain('daemon');

            const targetFilePath = join(targetWorkspaceRoot, 'README.md');
            await expect(readFile(targetFilePath, 'utf8')).rejects.toThrow();
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(sourceWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });
});
