import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('createWorkspaceReplicationBlobPackPayloadSource', () => {
  it('fails closed with a typed error when a requested digest is missing from CAS', async () => {
    const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-missing-'));

    try {
      const { createWorkspaceReplicationBlobPackPayloadSource } = await import('./createWorkspaceReplicationBlobPackPayloadSource');

      await expect(createWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir: sourceActiveServerDir,
        packId: 'pack_missing',
        digests: ['sha256:0000000000000000000000000000000000000000000000000000000000000000'],
      })).rejects.toMatchObject({
        name: 'WorkspaceReplicationError',
        code: 'missing_cas_blob',
      });
    } finally {
      await rm(sourceActiveServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the packId contains path traversal segments', async () => {
    const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-source-'));
    const sourceFilePath = join(sourceActiveServerDir, 'source.txt');
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        createWorkspaceReplicationBlobPackPayloadSource,
      } = await import('./createWorkspaceReplicationBlobPackPayloadSource');

      await writeFile(sourceFilePath, payload);
      const sourceCasStore = createWorkspaceReplicationCasStore({
        activeServerDir: sourceActiveServerDir,
      });
      await sourceCasStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });

      await expect(createWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir: sourceActiveServerDir,
        packId: '../escape',
        digests: [digest],
      })).rejects.toMatchObject({
        code: 'invalid_pack_id',
      });
    } finally {
      await rm(sourceActiveServerDir, { recursive: true, force: true });
    }
  });

  it('builds a file-backed blob pack payload source that round-trips into target CAS', async () => {
    const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-source-'));
    const targetActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-target-'));
    const sourceFilePath = join(sourceActiveServerDir, 'source.txt');
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        resolveTransferPayloadManifestHash,
        resolveTransferPayloadSizeBytes,
        disposeTransferPayloadSource,
      } = await import('@/machines/transfer/transferPayloadSource');
      const {
        createWorkspaceReplicationBlobPackPayloadSource,
      } = await import('./createWorkspaceReplicationBlobPackPayloadSource');
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveWorkspaceReplicationBlobPack');

      await writeFile(sourceFilePath, payload);
      const sourceCasStore = createWorkspaceReplicationCasStore({
        activeServerDir: sourceActiveServerDir,
      });
      await sourceCasStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });

      const payloadSource = await createWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir: sourceActiveServerDir,
        packId: 'pack_abc',
        digests: [digest],
      });

      expect(payloadSource.kind).toBe('file');
      if (payloadSource.kind !== 'file') {
        throw new Error('Expected a file-backed payload source');
      }
      await expect(resolveTransferPayloadSizeBytes(payloadSource)).resolves.toBeGreaterThan(payload.length);
      await expect(resolveTransferPayloadManifestHash(payloadSource)).resolves.toMatch(/^sha256:[a-f0-9]{64}$/u);

      const result = await receiveWorkspaceReplicationBlobPack({
        activeServerDir: targetActiveServerDir,
        jobId: 'job_transport_send_pack',
        packId: 'pack_abc',
        packFilePath: payloadSource.filePath,
        maxSingleBlobBytes: 1024,
      });

      expect(result).toEqual({
        receivedDigests: [digest],
        committedDigests: [digest],
        transferredBlobs: 1,
        transferredBytes: payload.length,
      });

      const targetCasStore = createWorkspaceReplicationCasStore({
        activeServerDir: targetActiveServerDir,
      });
      await expect(readFile(targetCasStore.resolveBlobPath(digest), 'utf8')).resolves.toBe('hello\n');

      await disposeTransferPayloadSource(payloadSource);
      await expect(readFile(payloadSource.filePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
    }
  });

  it('fails when any requested digest is missing from source CAS', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-source-'));

    try {
      const {
        createWorkspaceReplicationBlobPackPayloadSource,
      } = await import('./createWorkspaceReplicationBlobPackPayloadSource');

      await expect(createWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir,
        packId: 'pack_missing',
        digests: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      })).rejects.toThrow('Missing workspace replication CAS blob');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
