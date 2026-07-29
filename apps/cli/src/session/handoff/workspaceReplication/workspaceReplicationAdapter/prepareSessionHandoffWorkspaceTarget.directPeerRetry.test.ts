import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SessionHandoffWorkspaceTransfer, WorkspaceManifest } from '@happier-dev/protocol';

import { createScmBackendRegistry } from '@/scm/registry';
import type { SessionHandoffWorkspaceReplicationMetadata } from './metadata';
import { prepareSessionHandoffWorkspaceTarget } from './adapter';

import type { WorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';
import {
    createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer,
    createWorkspaceReplicationBlobPackEndMarkerBuffer,
    createWorkspaceReplicationBlobPackHeaderBuffer,
} from '@/workspaces/replication/transport/workspaceReplicationBlobPackFormatV1';

type RequestDirectPeerBlobPackToFile = WorkspaceReplicationTransfers['requestDirectPeerBlobPackToFile'];
type RequestServerRoutedBlobPackToFile = WorkspaceReplicationTransfers['requestServerRoutedBlobPackToFile'];
type RequestServerRoutedBlobPackInput = Parameters<RequestServerRoutedBlobPackToFile>[0];
type MachineTransferChannel = RequestServerRoutedBlobPackInput['machineTransferChannel'];

const scmRegistry = createScmBackendRegistry([]);

function sha256DigestOfString(value: string): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function writeWorkspaceReplicationBlobPackFile(input: Readonly<{
    destinationPath: string;
    blobs: readonly Readonly<{ digest: string; contents: string }>[];
}>): Promise<number> {
    const buffers: Buffer[] = [createWorkspaceReplicationBlobPackHeaderBuffer()];
    for (const blob of input.blobs) {
        const payload = Buffer.from(blob.contents, 'utf8');
        buffers.push(
            createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer({
                digest: blob.digest,
                sizeBytes: payload.byteLength,
            }),
            payload,
        );
    }
    buffers.push(createWorkspaceReplicationBlobPackEndMarkerBuffer());
    const output = Buffer.concat(buffers);
    await writeFile(input.destinationPath, output);
    return output.byteLength;
}

describe('prepareSessionHandoffWorkspaceTarget (direct-peer blob-pack retry)', () => {
    it('retries a transient direct-peer blob-pack failure before marking the workspace import failed', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-direct-peer-retry-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-direct-peer-retry-target-'));

        try {
            const fileContents = 'hello from retried direct peer blob pack\n';
            const fileDigest = sha256DigestOfString(fileContents);
            const sourceManifest: WorkspaceManifest = {
                entries: [
                    {
                        kind: 'file',
                        relativePath: 'retried.txt',
                        digest: fileDigest,
                        sizeBytes: Buffer.byteLength(fileContents),
                        executable: false,
                    },
                ],
            };
            const metadata: SessionHandoffWorkspaceReplicationMetadata = {
                sourceRootPath: '/source',
                manifest: sourceManifest,
            };
            const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
                enabled: true,
                strategy: 'transfer_snapshot',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            };

            let requestAttempts = 0;
            const requestDirectPeerBlobPackToFile: RequestDirectPeerBlobPackToFile = vi.fn(async (input) => {
                requestAttempts += 1;
                if (requestAttempts === 1) {
                    throw new Error('Direct peer transfer unavailable');
                }

                const sizeBytes = await writeWorkspaceReplicationBlobPackFile({
                    destinationPath: input.destinationPath,
                    blobs: [{ digest: fileDigest, contents: fileContents }],
                });
                const manifestHash = `sha256:${createHash('sha256').update(await readFile(input.destinationPath)).digest('hex')}`;
                return {
                    destinationPath: input.destinationPath,
                    manifestHash,
                    sizeBytes,
                };
            });

            const transfers: WorkspaceReplicationTransfers = {
                requestDirectPeerSourceOffer: async () => {
                    throw new Error('Unexpected direct-peer source-offer request');
                },
                requestServerRoutedSourceOffer: async () => {
                    throw new Error('Unexpected server-routed source-offer request');
                },
                publishDirectPeerBlobPack: () => [],
                requestDirectPeerBlobPackToFile,
                requestServerRoutedBlobPackToFile: async () => {
                    throw new Error('Unexpected server-routed blob-pack request');
                },
            };

            const result = await prepareSessionHandoffWorkspaceTarget({
                activeServerDir,
                actualTransportStrategy: 'direct_peer',
                handoffId: 'handoff_direct_peer_blob_pack_retry',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                targetPath: targetWorkspaceRoot,
                scmRegistry,
                workspaceTransfer,
                metadata,
                directPeerManifestEndpointCandidates: [
                    {
                        kind: 'http',
                        url: 'http://127.0.0.1:46001/machine-transfers/direct/manifest_transfer_key',
                        authorizationToken: 'test-token',
                        expiresAt: Date.now() + 30_000,
                    },
                ],
                transfers,
                blobPackTargetBytes: 1024,
                blobPackMaxBlobs: 10,
                blobPackMaxSingleBlobBytes: 1024 * 1024,
                serverRoutedTransferTimeoutMs: 12_345,
            });

            expect(requestDirectPeerBlobPackToFile).toHaveBeenCalledTimes(2);
            expect(await readFile(join(result.importedWorkspace.targetPath, 'retried.txt'), 'utf8')).toBe(fileContents);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('falls back to server-routed blob-pack transfer when direct peer auth returns 401 and fallback is allowed', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-direct-peer-fallback-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-direct-peer-fallback-target-'));

        try {
            const fileContents = 'hello from server-routed fallback blob pack\n';
            const fileDigest = sha256DigestOfString(fileContents);
            const sourceManifest: WorkspaceManifest = {
                entries: [
                    {
                        kind: 'file',
                        relativePath: 'fallback.txt',
                        digest: fileDigest,
                        sizeBytes: Buffer.byteLength(fileContents),
                        executable: false,
                    },
                ],
            };
            const metadata: SessionHandoffWorkspaceReplicationMetadata = {
                sourceRootPath: '/source',
                manifest: sourceManifest,
            };
            const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
                enabled: true,
                strategy: 'transfer_snapshot',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            };
            const directPeerBlobPackToFile = vi.fn(async () => {
                throw new Error('Direct peer request failed with status 401');
            });
            const serverRoutedBlobPackToFile: RequestServerRoutedBlobPackToFile = vi.fn(async (input) => {
                const sizeBytes = await writeWorkspaceReplicationBlobPackFile({
                    destinationPath: input.destinationPath,
                    blobs: [{ digest: fileDigest, contents: fileContents }],
                });
                const manifestHash = `sha256:${createHash('sha256').update(await readFile(input.destinationPath)).digest('hex')}`;
                return {
                    destinationPath: input.destinationPath,
                    manifestHash,
                    sizeBytes,
                };
            });

            const result = await prepareSessionHandoffWorkspaceTarget({
                activeServerDir,
                actualTransportStrategy: 'direct_peer',
                handoffId: 'handoff_direct_peer_blob_pack_401_fallback',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                targetPath: targetWorkspaceRoot,
                scmRegistry,
                workspaceTransfer,
                metadata,
                allowServerRoutedFallback: true,
                machineTransferChannel: {
                    onEnvelope: () => () => undefined,
                    sendEnvelope: () => undefined,
                } satisfies MachineTransferChannel,
                directPeerManifestEndpointCandidates: [
                    {
                        kind: 'http',
                        url: 'http://127.0.0.1:46001/machine-transfers/direct/manifest_transfer_key',
                        authorizationToken: 'test-token',
                        expiresAt: Date.now() + 30_000,
                    },
                ],
                transfers: {
                    requestDirectPeerSourceOffer: async () => {
                        throw new Error('Unexpected direct-peer source-offer request');
                    },
                    requestServerRoutedSourceOffer: async () => {
                        throw new Error('Unexpected server-routed source-offer request');
                    },
                    publishDirectPeerBlobPack: () => [],
                    requestDirectPeerBlobPackToFile: directPeerBlobPackToFile,
                    requestServerRoutedBlobPackToFile: serverRoutedBlobPackToFile,
                },
                blobPackTargetBytes: 1024,
                blobPackMaxBlobs: 10,
                blobPackMaxSingleBlobBytes: 1024 * 1024,
                serverRoutedTransferTimeoutMs: 12_345,
            });

            expect(directPeerBlobPackToFile).toHaveBeenCalled();
            expect(serverRoutedBlobPackToFile).toHaveBeenCalledTimes(1);
            expect(await readFile(join(result.importedWorkspace.targetPath, 'fallback.txt'), 'utf8')).toBe(fileContents);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });
});
