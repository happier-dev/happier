import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MachineTransferReceiveEnvelope, MachineTransferSendEnvelope, WorkspaceManifest } from '@happier-dev/protocol';

import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';

import type { SessionHandoffWorkspaceReplicationMetadata } from './sessionHandoffWorkspaceReplicationMetadata';

import { prepareSessionHandoffWorkspaceTarget } from './sessionHandoffWorkspaceReplicationAdapter';

function sha256DigestOfString(value: string): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('prepareSessionHandoffWorkspaceTarget (engine-runner, server_routed_stream)', () => {
    it('runs replication via the engine job runner (does not call the legacy apply/import injection)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-runner-'));
        const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-target-'));

        try {
            const fileContents = 'hello from server-routed engine runner\n';
            const fileDigest = sha256DigestOfString(fileContents);
            const seedPath = join(activeServerDir, 'seed.txt');
            await writeFile(seedPath, fileContents, 'utf8');

            const cas = createWorkspaceReplicationCasStore({ activeServerDir });
            await cas.commitFile({
                digest: fileDigest,
                sourcePath: seedPath,
            });

            const sourceManifest: WorkspaceManifest = {
                entries: [
                    {
                        kind: 'file',
                        relativePath: 'README.md',
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

            const offer = {
                offerId: 'offer_1',
                relationshipId: 'rel_1',
                directionId: 'dir_1',
                sourceFingerprint: sha256DigestOfString('offer-fp'),
                manifest: sourceManifest,
                blobIndex: [{ digest: fileDigest, sizeBytes: Buffer.byteLength(fileContents) }],
            } as const;

            const machineTransferChannel = {
                onEnvelope: (_listener: (payload: MachineTransferReceiveEnvelope) => void) => () => {},
                sendEnvelope: (_payload: MachineTransferSendEnvelope) => {},
            };

            const result = await prepareSessionHandoffWorkspaceTarget({
                activeServerDir,
                actualTransportStrategy: 'server_routed_stream',
                handoffId: 'handoff_engine_1',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                targetPath: targetWorkspaceRoot,
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'transfer_snapshot',
                    conflictPolicy: 'replace_existing',
                } as any,
                metadata,
                machineTransferChannel,
                transfers: {
                    requestServerRoutedSourceOffer: async () => offer,
                    requestServerRoutedBlobPackToFile: async () => {
                        throw new Error('Unexpected blob-pack request (CAS already seeded)');
                    },
                } as any,
	                blobPackTargetBytes: 1024,
	                blobPackMaxBlobs: 10,
	                blobPackMaxSingleBlobBytes: 1024 * 1024,
            });

            const importedTargetPath = result.importedWorkspace.targetPath;
            const written = await readFile(join(importedTargetPath, 'README.md'), 'utf8');
            expect(written).toBe(fileContents);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    });
});
