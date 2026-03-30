import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

async function writeBlobPackFile(input: Readonly<{
  filePath: string;
  blobs: readonly Readonly<{
    digest: string;
    content: Buffer;
  }>[];
  includeEndMarker?: boolean;
}>): Promise<void> {
  const {
    createWorkspaceReplicationBlobPackHeaderBuffer,
    createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer,
    createWorkspaceReplicationBlobPackEndMarkerBuffer,
  } = await import('./workspaceReplicationBlobPackFormatV1');

  const parts: Buffer[] = [
    createWorkspaceReplicationBlobPackHeaderBuffer(),
  ];
  for (const blob of input.blobs) {
    parts.push(createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer({
      digest: blob.digest,
      sizeBytes: blob.content.length,
    }));
    parts.push(blob.content);
  }
  if (input.includeEndMarker !== false) {
    parts.push(createWorkspaceReplicationBlobPackEndMarkerBuffer());
  }

  const file = await open(input.filePath, 'w');
  try {
    for (const part of parts) {
      await file.write(part);
    }
  } finally {
    await file.close();
  }
}

describe('receiveWorkspaceReplicationBlobPack', () => {
  it('fails closed when the packId contains path traversal segments', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-pack-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [
          {
            digest,
            content: payload,
          },
        ],
      });

      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveWorkspaceReplicationBlobPack');

      await expect(receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_pack',
        packId: '../escape',
        packFilePath,
        maxSingleBlobBytes: 1024,
      })).rejects.toMatchObject({
        code: 'invalid_pack_id',
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the packId exceeds the bounded maximum length', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-pack-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [
          {
            digest,
            content: payload,
          },
        ],
      });

      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveWorkspaceReplicationBlobPack');

      await expect(receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_pack',
        packId: 'p'.repeat(129),
        packFilePath,
        maxSingleBlobBytes: 1024,
      })).rejects.toMatchObject({
        code: 'invalid_pack_id',
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('streams a valid blob pack into CAS with truthful commit counters', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-pack-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [
          {
            digest,
            content: payload,
          },
        ],
      });

      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveWorkspaceReplicationBlobPack');

      const result = await receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_pack',
        packId: 'pack_abc',
        packFilePath,
        maxSingleBlobBytes: 1024,
      });

      expect(result).toEqual({
        receivedDigests: [digest],
        committedDigests: [digest],
        transferredBlobs: 1,
        transferredBytes: payload.length,
      });

      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir,
      });
      await expect(readFile(casStore.resolveBlobPath(digest), 'utf8')).resolves.toBe('hello\n');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails with a stable format error when EOF occurs before the end marker', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-pack-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [
          {
            digest,
            content: payload,
          },
        ],
        includeEndMarker: false,
      });

      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveWorkspaceReplicationBlobPack');

      await expect(receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_pack',
        packId: 'pack_abc',
        packFilePath,
        maxSingleBlobBytes: 1024,
      })).rejects.toMatchObject({
        code: 'invalid_blob_pack_format',
      });

      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir,
      });
      await expect(readFile(casStore.resolveBlobPath(digest), 'utf8')).resolves.toBe('hello\n');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('deletes temporary staging files when a blob digest does not match the pack header', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-pack-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('hello\n', 'utf8');
    const wrongDigest = createSha256Digest(Buffer.from('different\n', 'utf8'));

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [
          {
            digest: wrongDigest,
            content: payload,
          },
        ],
      });

      const {
        createWorkspaceReplicationPaths,
      } = await import('../state/workspaceReplicationPaths');
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveWorkspaceReplicationBlobPack');

      await expect(receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_pack',
        packId: 'pack_abc',
        packFilePath,
        maxSingleBlobBytes: 1024,
      })).rejects.toMatchObject({
        code: 'blob_digest_mismatch',
      });

      const paths = createWorkspaceReplicationPaths({
        activeServerDir,
      });
      const stagingEntries = await readdir(paths.stagingDirectory, { recursive: true }).catch(() => []);
      expect(stagingEntries).toEqual([]);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('treats a duplicate digest already present in CAS as a safe no-op commit', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-pack-'));
    const sourcePath = join(activeServerDir, 'source.txt');
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveWorkspaceReplicationBlobPack');
      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir,
      });

      await writeFile(sourcePath, payload);
      await casStore.commitFile({
        digest,
        sourcePath,
      });

      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [
          {
            digest,
            content: payload,
          },
        ],
      });

      const result = await receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_pack',
        packId: 'pack_abc',
        packFilePath,
        maxSingleBlobBytes: 1024,
      });

      expect(result).toEqual({
        receivedDigests: [digest],
        committedDigests: [],
        transferredBlobs: 0,
        transferredBytes: 0,
      });
      await expect(readFile(casStore.resolveBlobPath(digest), 'utf8')).resolves.toBe('hello\n');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
