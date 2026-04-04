import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';
import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import {
  createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer,
  createWorkspaceReplicationBlobPackEndMarkerBuffer,
  createWorkspaceReplicationBlobPackHeaderBuffer,
} from '@/workspaces/replication/transport/workspaceReplicationBlobPackFormatV1';
import type { WorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';
import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import { deterministicStringify } from '@/utils/deterministicJson';
import { configuration } from '@/configuration';
import { buildWorkspaceReplicationBlobPacks } from '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks';

import type { SessionHandoffWorkspaceReplicationMetadata } from './sessionHandoffWorkspaceReplicationMetadata';

import { prepareSessionHandoffWorkspaceTarget } from './sessionHandoffWorkspaceReplicationAdapter';

function sha256DigestOfString(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function createPackIdForDigests(digests: readonly string[]): string {
  const payload = deterministicStringify({
    schemaVersion: 1,
    digests,
  });
  return `pack_${createHash('sha256').update(payload).digest('hex')}`;
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

	describe('prepareSessionHandoffWorkspaceTarget (engine-runner, direct_peer)', () => {
	  it('requests missing-only pack boundaries over direct peer and supplies digests via the open-request body (incremental)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-'));
    const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-target-'));

    try {
      // Seed the target CAS with all blobs except two; direct-peer should request exactly the missing digests.
      const blobs = Array.from({ length: 257 }, (_, index) => {
        const contents = `blob_${index}`;
        const digest = sha256DigestOfString(contents);
        return { digest, contents };
      }).sort((left, right) => left.digest.localeCompare(right.digest));

      const missingA = blobs[0]!;
      const missingB = blobs[blobs.length - 1]!;

      const blobsByDigest = new Map<string, string>();
      for (const blob of blobs) {
        blobsByDigest.set(blob.digest, blob.contents);
      }

      const casStore = createWorkspaceReplicationCasStore({ activeServerDir });
      const seedDir = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-cas-seed-'));
      const seedPath = join(seedDir, 'seed.txt');
      try {
        for (const blob of blobs) {
          if (blob.digest === missingA.digest || blob.digest === missingB.digest) {
            continue;
          }
          await writeFile(seedPath, Buffer.from(blob.contents, 'utf8'));
          await casStore.commitFile({ digest: blob.digest, sourcePath: seedPath });
        }
      } finally {
        await rm(seedDir, { recursive: true, force: true }).catch(() => undefined);
      }

      const sourceManifest: WorkspaceManifest = {
        entries: blobs.map((blob, index) => ({
          kind: 'file',
          relativePath: `file_${index}.txt`,
          digest: blob.digest,
          sizeBytes: Buffer.byteLength(blob.contents, 'utf8'),
          executable: false,
        })),
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

      const missingDigests = [missingA.digest, missingB.digest].sort((left, right) => left.localeCompare(right));
      const expectedPackId = createPackIdForDigests(missingDigests);
      const expectedTransferId = `session-handoff:handoff_direct_peer_sparse_missing_1:workspace-pack-direct:${expectedPackId}`;
      const expectedEncodedTransferKey = Buffer.from(expectedTransferId, 'utf8').toString('base64url');

      const publishDirectPeerBlobPack = vi.fn(() => []);
      const requestDirectPeerBlobPackToFile = vi.fn(async (input) => {
        expect(input.transferId).toBe(expectedTransferId);
        expect(input.openBody).toEqual({
          t: 'workspace_replication_blob_pack_v1',
          packId: expectedPackId,
          digests: missingDigests,
        });
        expect(input.timeoutMs).toBe(12_345);
        // Adapter must rewrite endpoint candidates to point at the requested transferId, without query-param auth.
        expect(input.endpointCandidates).toEqual([
          {
            kind: 'http',
            url: `http://127.0.0.1:46001/machine-transfers/direct/${expectedEncodedTransferKey}`,
            authorizationToken: 'test-token',
            expiresAt: 999999,
          },
        ]);

        const sizeBytes = await writeWorkspaceReplicationBlobPackFile({
          destinationPath: input.destinationPath,
          blobs: missingDigests.map((digest) => ({
            digest,
            contents: blobsByDigest.get(digest) ?? (() => {
              throw new Error(`Missing contents for ${digest}`);
            })(),
          })),
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
        publishDirectPeerBlobPack,
        requestDirectPeerBlobPackToFile,
        requestServerRoutedBlobPackToFile: async () => {
          throw new Error('Unexpected server-routed blob-pack request');
        },
      };

      await prepareSessionHandoffWorkspaceTarget({
        activeServerDir,
        actualTransportStrategy: 'direct_peer',
        handoffId: 'handoff_direct_peer_sparse_missing_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: targetWorkspaceRoot,
        workspaceTransfer,
        metadata,
        directPeerManifestEndpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/manifest_transfer_key',
            authorizationToken: 'test-token',
            expiresAt: 999999,
          },
        ],
        transfers,
        blobPackTargetBytes: 1024,
        blobPackMaxBlobs: 10,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
        serverRoutedTransferTimeoutMs: 12_345,
      });

      // Direct-peer blob packs must be resolved on-demand only. No pre-publish path.
      expect(publishDirectPeerBlobPack).not.toHaveBeenCalled();
      expect(requestDirectPeerBlobPackToFile).toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
	  });

	  it('requests blob packs in batches derived from buildWorkspaceReplicationBlobPacks (not per-digest) when the target CAS is empty', async () => {
	    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-many-missing-'));
	    const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-many-missing-target-'));

	    try {
	      const blobs = Array.from({ length: 257 }, (_, index) => {
	        const contents = `blob_${index}`;
	        const digest = sha256DigestOfString(contents);
	        return { digest, contents };
	      }).sort((left, right) => left.digest.localeCompare(right.digest));

	      const blobsByDigest = new Map<string, string>();
	      for (const blob of blobs) {
	        blobsByDigest.set(blob.digest, blob.contents);
	      }

	      const sourceManifest: WorkspaceManifest = {
	        entries: blobs.map((blob, index) => ({
	          kind: 'file',
	          relativePath: `file_${index}.txt`,
	          digest: blob.digest,
	          sizeBytes: Buffer.byteLength(blob.contents, 'utf8'),
	          executable: false,
	        })),
	      };

	      const metadata: SessionHandoffWorkspaceReplicationMetadata = {
	        sourceRootPath: '/source',
	        manifest: sourceManifest,
	      };

	      const expectedPacks = buildWorkspaceReplicationBlobPacks({
	        blobs: sourceManifest.entries
	          .filter((entry) => entry.kind === 'file')
	          .map((entry) => ({ digest: entry.digest, sizeBytes: entry.sizeBytes })),
	        blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
	        blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
	        blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
	      });
	      expect(expectedPacks.length).toBeGreaterThan(0);

	      const publishDirectPeerBlobPack = vi.fn(() => []);
	      const requestDirectPeerBlobPackToFile = vi.fn(async (input) => {
	        const openBody = input.openBody as any;
	        expect(openBody).toMatchObject({
	          t: 'workspace_replication_blob_pack_v1',
	        });
	        expect(typeof openBody.packId).toBe('string');
	        expect(Array.isArray(openBody.digests)).toBe(true);

	        const sortedDigests = [...openBody.digests].sort((left: string, right: string) => left.localeCompare(right));
	        expect(openBody.digests).toEqual(sortedDigests);
	        expect(openBody.packId).toBe(createPackIdForDigests(openBody.digests));

	        const expectedTransferId = `session-handoff:handoff_direct_peer_many_missing_1:workspace-pack-direct:${openBody.packId}`;
	        expect(input.transferId).toBe(expectedTransferId);
	        expect(input.endpointCandidates).toEqual([
	          {
	            kind: 'http',
	            url: `http://127.0.0.1:46001/machine-transfers/direct/${Buffer.from(expectedTransferId, 'utf8').toString('base64url')}`,
	            authorizationToken: 'test-token',
	            expiresAt: 999999,
	          },
	        ]);

	        const sizeBytes = await writeWorkspaceReplicationBlobPackFile({
	          destinationPath: input.destinationPath,
	          blobs: openBody.digests.map((digest: string) => ({
	            digest,
	            contents: blobsByDigest.get(digest) ?? (() => {
	              throw new Error(`Missing contents for ${digest}`);
	            })(),
	          })),
	        });
	        const manifestHash = `sha256:${createHash('sha256').update(await readFile(input.destinationPath)).digest('hex')}`;
	        return {
	          destinationPath: input.destinationPath,
	          manifestHash,
	          sizeBytes,
	        };
	      });

	      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
	        enabled: true,
	        strategy: 'transfer_snapshot',
	        conflictPolicy: 'replace_existing',
	        includeIgnoredMode: 'exclude',
	        ignoredIncludeGlobs: [],
	      };

	      const transfers: WorkspaceReplicationTransfers = {
	        requestDirectPeerSourceOffer: async () => {
	          throw new Error('Unexpected direct-peer source-offer request');
	        },
	        requestServerRoutedSourceOffer: async () => {
	          throw new Error('Unexpected server-routed source-offer request');
	        },
	        publishDirectPeerBlobPack,
	        requestDirectPeerBlobPackToFile,
	        requestServerRoutedBlobPackToFile: async () => {
	          throw new Error('Unexpected server-routed blob-pack request');
	        },
	      };

	      const result = await prepareSessionHandoffWorkspaceTarget({
	        activeServerDir,
	        actualTransportStrategy: 'direct_peer',
	        handoffId: 'handoff_direct_peer_many_missing_1',
	        sourceMachineId: 'machine_source',
	        targetMachineId: 'machine_target',
	        targetPath: targetWorkspaceRoot,
	        workspaceTransfer,
	        metadata,
	        directPeerManifestEndpointCandidates: [
	          {
	            kind: 'http',
	            url: 'http://127.0.0.1:46001/machine-transfers/direct/manifest_transfer_key',
	            authorizationToken: 'test-token',
	            expiresAt: 999999,
	          },
	        ],
	        transfers,
	        blobPackTargetBytes: 1024,
	        blobPackMaxBlobs: 10,
	        blobPackMaxSingleBlobBytes: 1024 * 1024,
	      });

	      // No pre-publish path for direct-peer blob packs; they must be resolved on-demand.
	      expect(publishDirectPeerBlobPack).not.toHaveBeenCalled();

	      // Ensure we did not degenerate into per-digest requests.
	      expect(requestDirectPeerBlobPackToFile.mock.calls.length).toBe(expectedPacks.length);
	      expect(requestDirectPeerBlobPackToFile.mock.calls.length).toBeLessThan(blobs.length);

	      const requestedOpenBodies = requestDirectPeerBlobPackToFile.mock.calls.map((call) => (call[0] as any).openBody);
	      const requestedPackIds = requestedOpenBodies.map((openBody: any) => openBody.packId);
	      const expectedPackIds = expectedPacks.map((pack) => createPackIdForDigests(pack.digests));
	      expect(requestedPackIds).toEqual(expectedPackIds);

	      const importedTargetPath = result.importedWorkspace.targetPath;
	      expect(await readFile(join(importedTargetPath, 'file_0.txt'), 'utf8')).toBe(blobs[0]!.contents);
	      expect(await readFile(join(importedTargetPath, 'file_256.txt'), 'utf8')).toBe(blobs[256]!.contents);
	    } finally {
	      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
	      await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
	    }
	  });

	  it('requests blob packs via direct-peer transfers when needed (engine-owned job lifecycle)', async () => {
	    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-'));
	    const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-target-'));

    try {
      const fileAContents = 'hello from direct peer a\n';
      const fileBContents = 'hello from direct peer b\n';
      const fileADigest = sha256DigestOfString(fileAContents);
      const fileBDigest = sha256DigestOfString(fileBContents);

      const sourceManifest: WorkspaceManifest = {
        entries: [
          {
            kind: 'file',
            relativePath: 'a.txt',
            digest: fileADigest,
            sizeBytes: Buffer.byteLength(fileAContents),
            executable: false,
          },
          {
            kind: 'file',
            relativePath: 'b.txt',
            digest: fileBDigest,
            sizeBytes: Buffer.byteLength(fileBContents),
            executable: false,
          },
        ],
      };

      const metadata: SessionHandoffWorkspaceReplicationMetadata = {
        sourceRootPath: '/source',
        manifest: sourceManifest,
      };

      const packDigests = [fileADigest, fileBDigest].sort((left, right) => left.localeCompare(right));
      const expectedPackId = createPackIdForDigests(packDigests);
      const expectedTransferId = `session-handoff:handoff_direct_peer_1:workspace-pack-direct:${expectedPackId}`;
      const expectedEncodedTransferKey = Buffer.from(expectedTransferId, 'utf8').toString('base64url');

      let didRequestPack = false;
      const publishDirectPeerBlobPack = vi.fn(() => []);

      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const transfers: WorkspaceReplicationTransfers = {
        requestDirectPeerSourceOffer: async () => {
          throw new Error('Unexpected direct-peer source-offer request');
        },
        requestServerRoutedSourceOffer: async () => {
          throw new Error('Unexpected server-routed source-offer request');
        },
        publishDirectPeerBlobPack,
        requestDirectPeerBlobPackToFile: async (input) => {
          didRequestPack = true;
          expect(input.transferId).toBe(expectedTransferId);
          expect(input.openBody).toEqual({
            t: 'workspace_replication_blob_pack_v1',
            packId: expectedPackId,
            digests: packDigests,
          });
          expect(input.endpointCandidates).toEqual([
            {
              kind: 'http',
              url: `http://127.0.0.1:46001/machine-transfers/direct/${expectedEncodedTransferKey}`,
              authorizationToken: 'test-token',
              expiresAt: 999999,
            },
          ]);
          const sizeBytes = await writeWorkspaceReplicationBlobPackFile({
            destinationPath: input.destinationPath,
            blobs: [
              { digest: fileADigest, contents: fileAContents },
              { digest: fileBDigest, contents: fileBContents },
            ],
          });
          const manifestHash = `sha256:${createHash('sha256').update(await readFile(input.destinationPath)).digest('hex')}`;
          return {
            destinationPath: input.destinationPath,
            manifestHash,
            sizeBytes,
          };
        },
        requestServerRoutedBlobPackToFile: async () => {
          throw new Error('Unexpected server-routed blob-pack request');
        },
      };

      const result = await prepareSessionHandoffWorkspaceTarget({
        activeServerDir,
        actualTransportStrategy: 'direct_peer',
        handoffId: 'handoff_direct_peer_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: targetWorkspaceRoot,
        workspaceTransfer,
        metadata,
        directPeerManifestEndpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/manifest_transfer_key',
            authorizationToken: 'test-token',
            expiresAt: 999999,
          },
        ],
        transfers,
        blobPackTargetBytes: 1024,
        blobPackMaxBlobs: 10,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
      });

      expect(didRequestPack).toBe(true);
      expect(publishDirectPeerBlobPack).not.toHaveBeenCalled();

      const importedTargetPath = result.importedWorkspace.targetPath;
      expect(await readFile(join(importedTargetPath, 'a.txt'), 'utf8')).toBe(fileAContents);
      expect(await readFile(join(importedTargetPath, 'b.txt'), 'utf8')).toBe(fileBContents);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed instead of falling back to legacy workspace import when workspace transfer is enabled but no source offer can be resolved', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-'));
    const targetWorkspaceRoot = await mkdtemp(join(tmpdir(), 'happier-handoff-engine-direct-peer-target-'));

    try {
      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };

      const transfers: WorkspaceReplicationTransfers = {
        requestDirectPeerSourceOffer: async () => {
          throw new Error('Unexpected direct-peer source-offer request');
        },
        requestServerRoutedSourceOffer: async () => {
          throw new Error('Unexpected server-routed source-offer request');
        },
        publishDirectPeerBlobPack: () => [],
        requestDirectPeerBlobPackToFile: async () => {
          throw new Error('Unexpected direct-peer blob-pack request');
        },
        requestServerRoutedBlobPackToFile: async () => {
          throw new Error('Unexpected server-routed blob-pack request');
        },
      };

      await expect(prepareSessionHandoffWorkspaceTarget({
        activeServerDir,
        actualTransportStrategy: 'direct_peer',
        handoffId: 'handoff_direct_peer_missing_offer',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: targetWorkspaceRoot,
        workspaceTransfer,
        metadata: undefined,
        transfers,
        blobPackTargetBytes: 1024,
        blobPackMaxBlobs: 10,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
      })).rejects.toThrow('Missing workspace replication source offer');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // Baseline-missing fallback to transfer_snapshot is enforced by
  // prepareSessionHandoffWorkspaceTarget.oneWaySafe.test.ts (canonical behavior).
});
