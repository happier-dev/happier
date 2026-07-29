import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let maxWriteBytesPerCall: number | null = null;
let failWriteAfterSuccessfulCalls: number | null = null;
let successfulWriteCalls = 0;
let writeFailure: Error | null = null;
let nextWritableCloseFailure: Error | null = null;
let writablePaths: string[] = [];

type BufferFileWrite = (
  buffer: Uint8Array,
  offset?: number | null,
  length?: number | null,
  position?: number | null,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const flags = args[1];
      const writable = typeof flags === 'string' && (flags.includes('w') || flags.includes('a') || flags.includes('+'));
      if (writable) {
        writablePaths.push(String(args[0]));
      }
      const write = handle.write.bind(handle) as BufferFileWrite;
      Object.defineProperty(handle, 'write', {
        configurable: true,
        value: async (
          buffer: Uint8Array,
          offset = 0,
          length = buffer.byteLength - offset,
          position: number | null = null,
        ) => {
          if (failWriteAfterSuccessfulCalls !== null && successfulWriteCalls >= failWriteAfterSuccessfulCalls) {
            throw writeFailure ?? new Error('simulated blob-pack write failure');
          }
          const result = await write(
            buffer,
            offset,
            maxWriteBytesPerCall === null ? length : Math.min(length, maxWriteBytesPerCall),
            position,
          );
          successfulWriteCalls += 1;
          return result;
        },
      });
      if (writable) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, 'close', {
          configurable: true,
          value: async () => {
            await close();
            if (nextWritableCloseFailure !== null) {
              const error = nextWritableCloseFailure;
              nextWritableCloseFailure = null;
              throw error;
            }
          },
        });
      }
      return handle as FileHandle;
    }),
  };
});

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

describe('createWorkspaceReplicationBlobPackPayloadSource', () => {
  afterEach(() => {
    maxWriteBytesPerCall = null;
    failWriteAfterSuccessfulCalls = null;
    successfulWriteCalls = 0;
    writeFailure = null;
    nextWritableCloseFailure = null;
    writablePaths = [];
    vi.clearAllMocks();
  });

  it('fails closed with a typed error when a requested digest is missing from CAS', async () => {
    const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-missing-'));

    try {
      const { createWorkspaceReplicationBlobPackPayloadSource } = await import('./blobPackPayloadSource');

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
      } = await import('./blobPackPayloadSource');

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
      } = await import('./blobPackPayloadSource');
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveBlobPack');

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

  it('publishes the exact file size and manifest after progressing filesystem short writes', async () => {
    const sourceActiveServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-short-write-'));
    const sourceFilePath = join(sourceActiveServerDir, 'source.txt');
    const payload = Buffer.from('short-write-workspace-payload\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        disposeTransferPayloadSource,
        resolveTransferPayloadManifestHash,
        resolveTransferPayloadSizeBytes,
      } = await import('@/machines/transfer/transferPayloadSource');
      const {
        createWorkspaceReplicationBlobPackPayloadSource,
      } = await import('./blobPackPayloadSource');

      await writeFile(sourceFilePath, payload);
      const sourceCasStore = createWorkspaceReplicationCasStore({
        activeServerDir: sourceActiveServerDir,
      });
      await sourceCasStore.commitFile({
        digest,
        sourcePath: sourceFilePath,
      });
      maxWriteBytesPerCall = 2;

      const payloadSource = await createWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir: sourceActiveServerDir,
        packId: 'pack_short_write',
        digests: [digest],
      });
      try {
        expect(payloadSource.kind).toBe('file');
        if (payloadSource.kind !== 'file') {
          throw new Error('Expected a file-backed payload source');
        }
        const fileBytes = await readFile(payloadSource.filePath);
        await expect(resolveTransferPayloadSizeBytes(payloadSource)).resolves.toBe(fileBytes.byteLength);
        await expect(resolveTransferPayloadManifestHash(payloadSource)).resolves.toBe(createSha256Digest(fileBytes));
        await expect(stat(payloadSource.filePath)).resolves.toMatchObject({ size: fileBytes.byteLength });
      } finally {
        await disposeTransferPayloadSource(payloadSource);
      }
    } finally {
      await rm(sourceActiveServerDir, { recursive: true, force: true });
    }
  });

  it('preserves the primary write failure and removes the unpublished pack when close also fails', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-write-close-failure-'));

    try {
      const {
        createWorkspaceReplicationBlobPackPayloadSource,
      } = await import('./blobPackPayloadSource');
      const primaryFailure = new Error('simulated blob-pack write failure after progress');
      const closeFailure = new Error('simulated blob-pack close failure');
      writablePaths = [];
      maxWriteBytesPerCall = 2;
      failWriteAfterSuccessfulCalls = 1;
      writeFailure = primaryFailure;
      nextWritableCloseFailure = closeFailure;

      const outcome = await createWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir,
        packId: 'pack_write_close_failure',
        digests: [],
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBe(primaryFailure);
      expect(writablePaths).toHaveLength(1);
      await expect(stat(writablePaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await Promise.all(writablePaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects a success-path close failure and removes the unpublished pack', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-close-failure-'));

    try {
      const {
        createWorkspaceReplicationBlobPackPayloadSource,
      } = await import('./blobPackPayloadSource');
      const closeFailure = new Error('simulated blob-pack success close failure');
      writablePaths = [];
      nextWritableCloseFailure = closeFailure;

      const outcome = await createWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir,
        packId: 'pack_close_failure',
        digests: [],
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBe(closeFailure);
      expect(writablePaths).toHaveLength(1);
      await expect(stat(writablePaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await Promise.all(writablePaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails when any requested digest is missing from source CAS', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-blob-pack-source-'));

    try {
      const {
        createWorkspaceReplicationBlobPackPayloadSource,
      } = await import('./blobPackPayloadSource');

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
