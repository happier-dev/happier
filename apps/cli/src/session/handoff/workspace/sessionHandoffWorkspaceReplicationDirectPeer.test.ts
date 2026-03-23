import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

function createSha256Digest(payload: Buffer): string {
    return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('sessionHandoffWorkspaceReplicationDirectPeer', () => {
    afterEach(() => {
        delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS;
    });

    it('receives direct-peer workspace blob packs from publication metadata carried through the transferred-bundles file header', async () => {
        process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS = '127.0.0.1';

        const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-session-handoff-workspace-direct-peer-source-'));
        const targetActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-session-handoff-workspace-direct-peer-target-'));

        const {
            createDirectPeerTransferRegistry,
            requestDirectPeerTransferToFile,
            startDirectPeerTransferServer,
        } = await import('@/machines/transfer/directPeerTransport');
        const { createWorkspaceReplicationCasStore } = await import('@/workspaces/replication/cas/workspaceReplicationCasStore');
        const { createWorkspaceReplicationTransfers } = await import('@/workspaces/replication/transport/workspaceReplicationTransfers');
        const {
            createSessionHandoffTransferredBundles,
            createSessionHandoffTransferredBundlesPayloadSource,
            receiveSessionHandoffTransferredBundlesPayloadFile,
        } = await import('../transfer/sessionHandoffTransferredBundles');
        const {
            createSessionHandoffMetadataV2,
        } = await import('../transfer/sessionHandoffMetadataV2');
        const {
            createSessionHandoffWorkspaceReplicationMetadata,
        } = await import('./sessionHandoffWorkspaceReplicationMetadata');
        const {
            publishSessionHandoffWorkspaceReplicationDirectPeerTransfers,
            receiveDirectPeerSessionHandoffWorkspaceReplication,
        } = await import('./sessionHandoffWorkspaceReplicationDirectPeer');

        let registry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
        const publishedTransferPayloads = new Map<string, unknown>();
        const server = await startDirectPeerTransferServer({
            readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
        });
        registry = createDirectPeerTransferRegistry({
            advertisedPort: server.port,
        });

        try {
            const payload = Buffer.from('direct-peer workspace payload\n', 'utf8');
            const digest = createSha256Digest(payload);
            const sourceBlobPath = join(sourceActiveServerDir, 'README.md');
            await writeFile(sourceBlobPath, payload);

            const sourceCasStore = createWorkspaceReplicationCasStore({
                activeServerDir: sourceActiveServerDir,
            });
            await sourceCasStore.commitFile({
                digest,
                sourcePath: sourceBlobPath,
            });

            const workspaceExportArtifacts = {
                manifest: {
                    entries: [
                        {
                            relativePath: 'README.md',
                            kind: 'file' as const,
                            digest,
                            sizeBytes: payload.byteLength,
                            executable: false,
                        },
                    ],
                    fingerprint: createSha256Digest(Buffer.from('manifest-fingerprint', 'utf8')),
                },
                blobContentsByDigest: new Map<string, Uint8Array>([
                    [digest, payload],
                ]),
                sourceControllerMetadata: {
                    scmBackendId: 'git',
                },
            };
            const transferredBundles = createSessionHandoffTransferredBundles({
                workspaceExportArtifacts,
            });
            const workspaceReplicationMetadata = createSessionHandoffWorkspaceReplicationMetadata({
                sourceRootPath: '/Users/tester/projects/direct-peer',
                workspaceExportArtifacts,
            });

            const publishedWorkspaceTransfers =
                await publishSessionHandoffWorkspaceReplicationDirectPeerTransfers({
                    handoffId: 'handoff_direct_peer_test',
                    activeServerDir: sourceActiveServerDir,
                    manifest: workspaceExportArtifacts.manifest,
                    directPeerTransfer: {
                        publishTransfer: ({ transferId, payload, payloadSource }) => {
                            publishedTransferPayloads.set(transferId, payload);
                            return registry!.publishTransfer({
                                transferId,
                                payloadSource,
                            }).endpointCandidates;
                        },
                    },
                    workspaceExportArtifacts,
                });
            const publishedBlobPack = publishedWorkspaceTransfers.publication.blobPacks[0];
            expect(publishedBlobPack).toBeDefined();
            expect(publishedTransferPayloads.get(publishedBlobPack.transferId)).toEqual({});
            expect(publishedBlobPack.endpointCandidates[0]).toMatchObject({
                kind: 'http',
                authorizationToken: expect.any(String),
            });
            expect(
                registry.readPublishedTransfer({
                    transferId: publishedBlobPack.transferId,
                    transferToken: publishedBlobPack.endpointCandidates[0]!.authorizationToken!,
                }),
            ).not.toBeNull();

            const directRequestPath = join(targetActiveServerDir, 'preheader-pack.bin');
            await expect(requestDirectPeerTransferToFile({
                transferId: publishedBlobPack.transferId,
                endpointCandidates: publishedBlobPack.endpointCandidates,
                destinationPath: directRequestPath,
            })).resolves.toMatchObject({
                destinationPath: directRequestPath,
            });

            const transferredPayloadSource = await createSessionHandoffTransferredBundlesPayloadSource(
                transferredBundles,
                {
                    includeWorkspaceBlobPayloads: false,
                    handoffMetadataV2: createSessionHandoffMetadataV2({
                        workspaceReplicationMetadata,
                        workspaceReplicationDirectPeerPublication: publishedWorkspaceTransfers.publication,
                    }),
                },
            );
            if (transferredPayloadSource.kind !== 'file') {
                throw new Error('Expected a file-backed transferred payload source');
            }

            const receivedTransferredPayload = await receiveSessionHandoffTransferredBundlesPayloadFile({
                activeServerDir: targetActiveServerDir,
                payloadFilePath: transferredPayloadSource.filePath,
            });
            expect(receivedTransferredPayload).not.toHaveProperty('workspaceReplicationMetadata');
            expect(receivedTransferredPayload.handoffMetadataV2?.workspaceReplicationMetadata).toEqual(
                workspaceReplicationMetadata,
            );
            expect(
                receivedTransferredPayload.handoffMetadataV2?.workspaceReplicationDirectPeerPublication?.blobPacks[0]?.endpointCandidates[0],
            ).toMatchObject({
                kind: 'http',
                authorizationToken: expect.any(String),
            });

            const result = await receiveDirectPeerSessionHandoffWorkspaceReplication({
                activeServerDir: targetActiveServerDir,
                handoffId: 'handoff_direct_peer_test',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                targetPath: '/Users/tester/projects/target',
                metadata: receivedTransferredPayload.handoffMetadataV2!.workspaceReplicationMetadata!,
                directPeerPublication: receivedTransferredPayload.handoffMetadataV2!.workspaceReplicationDirectPeerPublication!,
                transfers: createWorkspaceReplicationTransfers(),
                maxSingleBlobBytes: 1024 * 1024,
            });

            expect(result.transferredPackCount).toBe(1);
            expect(result.transferredBlobs).toBe(1);
            expect(result.transferredBytes).toBeGreaterThan(0);

            const targetCasStore = createWorkspaceReplicationCasStore({
                activeServerDir: targetActiveServerDir,
            });
            await expect(targetCasStore.contains(digest)).resolves.toBe(true);

            await transferredPayloadSource.dispose?.();
            for (const publishedPayloadSource of publishedWorkspaceTransfers.payloadSources) {
                registry.clearPublishedTransfer(publishedPayloadSource.transferId);
                await publishedPayloadSource.payloadSource.dispose?.();
            }
        } finally {
            await server.stop();
            await rm(sourceActiveServerDir, { recursive: true, force: true });
            await rm(targetActiveServerDir, { recursive: true, force: true });
        }
    });
});
