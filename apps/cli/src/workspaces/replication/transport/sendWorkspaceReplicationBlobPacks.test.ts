import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('sendWorkspaceReplicationBlobPacks', () => {
  it('publishes planned blob packs over direct peer transport and commits them into target CAS', async () => {
    const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-send-packs-source-'));
    const targetActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-send-packs-target-'));

    try {
      const payloadA = Buffer.from('alpha\n', 'utf8');
      const payloadB = Buffer.from('beta\n', 'utf8');
      const digestA = createSha256Digest(payloadA);
      const digestB = createSha256Digest(payloadB);
      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
      const { sendWorkspaceReplicationBlobPacks } = await import('./sendWorkspaceReplicationBlobPacks');

      const sourceCasStore = createWorkspaceReplicationCasStore({
        activeServerDir: sourceActiveServerDir,
      });
      const targetCasStore = createWorkspaceReplicationCasStore({
        activeServerDir: targetActiveServerDir,
      });
      const sourceFileA = join(sourceActiveServerDir, 'alpha.txt');
      const sourceFileB = join(sourceActiveServerDir, 'beta.txt');
      await writeFile(sourceFileA, payloadA);
      await writeFile(sourceFileB, payloadB);
      await sourceCasStore.commitFile({
        digest: digestA,
        sourcePath: sourceFileA,
      });
      await sourceCasStore.commitFile({
        digest: digestB,
        sourcePath: sourceFileB,
      });

      const publishedSources = new Map<string, string>();
      const result = await sendWorkspaceReplicationBlobPacks({
        sourceActiveServerDir,
        targetActiveServerDir,
        jobId: 'job_send_packs_direct',
        sourceMachineId: 'machine_source',
        negotiatedTransportStrategy: 'direct_peer',
        maxSingleBlobBytes: 1024,
        packs: [
          {
            packId: 'pack_alpha_beta',
            digests: [digestA, digestB],
            totalBytes: payloadA.byteLength + payloadB.byteLength,
          },
	        ],
	        transfers: {
	          requestDirectPeerSourceOffer: async () => {
	            throw new Error('Unexpected direct-peer source offer request');
	          },
	          requestServerRoutedSourceOffer: async () => {
            throw new Error('Unexpected server-routed source offer request');
          },
          publishDirectPeerBlobPack: ({ transferId, payloadSource }) => {
            if (payloadSource.kind !== 'file') {
              throw new Error('Expected a file-backed blob-pack payload source');
            }
            publishedSources.set(transferId, payloadSource.filePath);
            return [
              {
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/blob-pack',
                authorizationToken: 'token',
                expiresAt: Date.now() + 60_000,
              },
            ];
          },
          requestDirectPeerBlobPackToFile: async ({ transferId, destinationPath }) => {
            const sourcePath = publishedSources.get(transferId);
            if (!sourcePath) {
              throw new Error(`Missing published blob pack source for ${transferId}`);
            }
            await copyFile(sourcePath, destinationPath);
            return {
              destinationPath,
              manifestHash: 'sha256:direct-peer-pack',
              sizeBytes: payloadA.byteLength + payloadB.byteLength,
            };
          },
          requestServerRoutedBlobPackToFile: async () => {
            throw new Error('Unexpected server-routed blob-pack request');
          },
        },
        directPeerTransfer: {
          publishTransfer: ({ transferId, payloadSource }) => {
            if (payloadSource.kind !== 'file') {
              throw new Error('Expected a file-backed blob-pack payload source');
            }
            publishedSources.set(transferId, payloadSource.filePath);
            return [
              {
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/blob-pack',
                authorizationToken: 'token',
                expiresAt: Date.now() + 60_000,
              },
            ];
          },
        },
      });

      expect(result).toEqual({
        packResults: [
          {
            packId: 'pack_alpha_beta',
            receivedDigests: [digestA, digestB],
            committedDigests: [digestA, digestB],
            transferredBlobs: 2,
            transferredBytes: payloadA.byteLength + payloadB.byteLength,
          },
        ],
        transferredPackCount: 1,
        receivedDigests: [digestA, digestB],
        committedDigests: [digestA, digestB],
        transferredBlobs: 2,
        transferredBytes: payloadA.byteLength + payloadB.byteLength,
      });
      await expect(targetCasStore.contains(digestA)).resolves.toBe(true);
      await expect(targetCasStore.contains(digestB)).resolves.toBe(true);
    } finally {
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
    }
  });

  it('uses the server-routed file request path when the negotiated strategy is server_routed_stream', async () => {
    const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-send-packs-source-'));
    const targetActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-send-packs-target-'));

    try {
      const payload = Buffer.from('server-routed\n', 'utf8');
      const digest = createSha256Digest(payload);
      const { createWorkspaceReplicationCasStore } = await import('../cas/workspaceReplicationCasStore');
      const { sendWorkspaceReplicationBlobPacks } = await import('./sendWorkspaceReplicationBlobPacks');

      const sourceCasStore = createWorkspaceReplicationCasStore({
        activeServerDir: sourceActiveServerDir,
      });
      const targetCasStore = createWorkspaceReplicationCasStore({
        activeServerDir: targetActiveServerDir,
      });
      const sourceFilePath = join(sourceActiveServerDir, 'server-routed.txt');
      await writeFile(sourceFilePath, payload);
      await sourceCasStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });

      const publishedSources = new Map<string, string>();
      let serverRoutedRequests = 0;
      const result = await sendWorkspaceReplicationBlobPacks({
        sourceActiveServerDir,
        targetActiveServerDir,
        jobId: 'job_send_packs_server',
        sourceMachineId: 'machine_source',
        negotiatedTransportStrategy: 'server_routed_stream',
        machineTransferChannel: {
          onEnvelope: () => () => undefined,
          sendEnvelope: () => undefined,
        },
        maxSingleBlobBytes: 1024,
        packs: [
          {
            packId: 'pack_server_routed',
            digests: [digest],
            totalBytes: payload.byteLength,
          },
	        ],
	        transfers: {
	          requestDirectPeerSourceOffer: async () => {
	            throw new Error('Unexpected direct-peer source offer request');
	          },
	          requestServerRoutedSourceOffer: async () => {
            throw new Error('Unexpected server-routed source offer request');
          },
          publishDirectPeerBlobPack: ({ transferId, payloadSource }) => {
            if (payloadSource.kind !== 'file') {
              throw new Error('Expected a file-backed blob-pack payload source');
            }
            publishedSources.set(transferId, payloadSource.filePath);
            return [];
          },
          requestDirectPeerBlobPackToFile: async () => {
            throw new Error('Unexpected direct-peer blob-pack request');
          },
          requestServerRoutedBlobPackToFile: async ({ transferId, destinationPath }) => {
            serverRoutedRequests += 1;
            const sourcePath = publishedSources.get(transferId);
            if (!sourcePath) {
              throw new Error(`Missing published blob pack source for ${transferId}`);
            }
            await copyFile(sourcePath, destinationPath);
            return {
              destinationPath,
              manifestHash: 'sha256:server-routed-pack',
              sizeBytes: payload.byteLength,
            };
          },
        },
      });

      expect(serverRoutedRequests).toBe(1);
      expect(result.transferredPackCount).toBe(1);
      expect(result.committedDigests).toEqual([digest]);
      await expect(targetCasStore.contains(digest)).resolves.toBe(true);
    } finally {
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
    }
  });
});
