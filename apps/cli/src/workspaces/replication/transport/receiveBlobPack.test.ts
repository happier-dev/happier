import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let maxWriteBytesPerCall: number | null = null;
let failWriteAfterSuccessfulCalls: number | null = null;
let successfulWriteCalls = 0;
let writeFailure: Error | null = null;
let nextWritableCloseFailure: Error | null = null;
let writablePaths: string[] = [];
let mkdirFailurePathPrefix: string | null = null;
let mkdirFailure: Error | null = null;
let virtualWindowsDirectories: Map<string, string[]> | null = null;
let removedVirtualWindowsDirectories: string[] = [];

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
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      const path = String(args[0]);
      if (mkdirFailurePathPrefix !== null
        && (path === mkdirFailurePathPrefix
          || path.startsWith(`${mkdirFailurePathPrefix}/`)
          || path.startsWith(`${mkdirFailurePathPrefix}\\`))) {
        throw mkdirFailure ?? new Error('simulated directory creation failure');
      }
      return await actual.mkdir(...args);
    }),
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      const path = String(args[0]);
      if (virtualWindowsDirectories !== null && path.includes('\\')) {
        const entries = virtualWindowsDirectories.get(path);
        if (!entries) {
          const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return [...entries];
      }
      return await actual.readdir(...args);
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      const path = String(args[0]);
      if (virtualWindowsDirectories !== null && path.includes('\\')) {
        if (!virtualWindowsDirectories.has(path)) {
          return;
        }
        removedVirtualWindowsDirectories.push(path);
        virtualWindowsDirectories.delete(path);
        const separatorIndex = path.lastIndexOf('\\');
        if (separatorIndex >= 0) {
          const parent = path.slice(0, separatorIndex);
          const name = path.slice(separatorIndex + 1);
          const siblings = virtualWindowsDirectories.get(parent);
          if (siblings) {
            virtualWindowsDirectories.set(parent, siblings.filter((entry) => entry !== name));
          }
        }
        return;
      }
      await actual.rm(...args);
    }),
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
            throw writeFailure ?? new Error('simulated received-blob write failure');
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
  afterEach(() => {
    maxWriteBytesPerCall = null;
    failWriteAfterSuccessfulCalls = null;
    successfulWriteCalls = 0;
    writeFailure = null;
    nextWritableCloseFailure = null;
    writablePaths = [];
    mkdirFailurePathPrefix = null;
    mkdirFailure = null;
    virtualWindowsDirectories = null;
    removedVirtualWindowsDirectories = [];
    vi.clearAllMocks();
  });

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
      } = await import('./receiveBlobPack');

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
      } = await import('./receiveBlobPack');

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
      } = await import('./receiveBlobPack');

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

  it('commits every blob byte after progressing filesystem short writes', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-short-write-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('short-write-received-blob\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [{ digest, content: payload }],
      });

      const {
        createWorkspaceReplicationCasStore,
      } = await import('../cas/workspaceReplicationCasStore');
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveBlobPack');
      maxWriteBytesPerCall = 2;

      await expect(receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_short_write',
        packId: 'pack_short_write',
        packFilePath,
        maxSingleBlobBytes: 1024,
      })).resolves.toEqual({
        receivedDigests: [digest],
        committedDigests: [digest],
        transferredBlobs: 1,
        transferredBytes: payload.length,
      });

      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir,
      });
      await expect(readFile(casStore.resolveBlobPath(digest))).resolves.toEqual(payload);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('preserves the primary blob write failure and removes staging when close also fails', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-write-close-failure-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('received blob write failure after progress', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [{ digest, content: payload }],
      });
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveBlobPack');
      const primaryFailure = new Error('simulated received-blob write failure after progress');
      const closeFailure = new Error('simulated received-blob close failure');
      writablePaths = [];
      successfulWriteCalls = 0;
      maxWriteBytesPerCall = 2;
      failWriteAfterSuccessfulCalls = 1;
      writeFailure = primaryFailure;
      nextWritableCloseFailure = closeFailure;

      const outcome = await receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_write_close_failure',
        packId: 'pack_write_close_failure',
        packFilePath,
        maxSingleBlobBytes: 1024,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBe(primaryFailure);
      expect(writablePaths).toHaveLength(1);
      await expect(stat(writablePaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects a successful blob write when close fails and removes its staging file', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-close-failure-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('received blob close failure', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [{ digest, content: payload }],
      });
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveBlobPack');
      const closeFailure = new Error('simulated received-blob success close failure');
      writablePaths = [];
      successfulWriteCalls = 0;
      nextWritableCloseFailure = closeFailure;

      const outcome = await receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_close_failure',
        packId: 'pack_close_failure',
        packFilePath,
        maxSingleBlobBytes: 1024,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBe(closeFailure);
      expect(writablePaths).toHaveLength(1);
      await expect(stat(writablePaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('walks Windows cleanup by parents without touching an empty prefix sibling', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const stagingDirectory = String.raw`C:\happier\workspace-replication\staging`;
    const packRoot = win32.join(stagingDirectory, 'job_1', 'blob-packs');
    const prefixSibling = win32.join(packRoot, 'pack');
    const packDirectory = win32.join(packRoot, 'pack-long');
    virtualWindowsDirectories = new Map([
      [stagingDirectory, ['job_1']],
      [win32.join(stagingDirectory, 'job_1'), ['blob-packs']],
      [packRoot, ['pack', 'pack-long']],
      [prefixSibling, []],
      [packDirectory, []],
    ]);

    try {
      const receiverModule = await import('./receiveBlobPack');
      const cleanup = Reflect.get(receiverModule, 'removeEmptyDirectoriesUpTo') as unknown;
      if (typeof cleanup !== 'function') {
        throw new Error('Expected the receive-blob-pack cleanup owner to expose parent-walk behavior');
      }

      await (cleanup as (input: Readonly<{
        startDirectory: string;
        stopDirectory: string;
      }>) => Promise<void>)({
        startDirectory: packDirectory,
        stopDirectory: stagingDirectory,
      });

      expect(removedVirtualWindowsDirectories).toEqual([packDirectory]);
      expect(virtualWindowsDirectories.has(prefixSibling)).toBe(true);
      expect(virtualWindowsDirectories.get(packRoot)).toEqual(['pack']);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not clean a Windows directory whose root is only a string-prefix sibling', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const stagingDirectory = String.raw`C:\happier\workspace-replication\staging`;
    const prefixSiblingRoot = String.raw`C:\happier\workspace-replication\staging-sibling`;
    const packDirectory = win32.join(prefixSiblingRoot, 'job_1', 'blob-packs', 'pack_1');
    virtualWindowsDirectories = new Map([
      [prefixSiblingRoot, ['job_1']],
      [win32.join(prefixSiblingRoot, 'job_1'), ['blob-packs']],
      [win32.join(prefixSiblingRoot, 'job_1', 'blob-packs'), ['pack_1']],
      [packDirectory, []],
    ]);

    try {
      const receiverModule = await import('./receiveBlobPack');
      const cleanup = Reflect.get(receiverModule, 'removeEmptyDirectoriesUpTo') as unknown;
      if (typeof cleanup !== 'function') {
        throw new Error('Expected the receive-blob-pack cleanup owner to expose parent-walk behavior');
      }

      await (cleanup as (input: Readonly<{
        startDirectory: string;
        stopDirectory: string;
      }>) => Promise<void>)({
        startDirectory: packDirectory,
        stopDirectory: stagingDirectory,
      });

      expect(removedVirtualWindowsDirectories).toEqual([]);
      expect(virtualWindowsDirectories.has(packDirectory)).toBe(true);
    } finally {
      platformSpy.mockRestore();
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
      } = await import('./receiveBlobPack');

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
      } = await import('./receiveBlobPack');

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

  it('deletes temporary staging files when committing the verified blob into CAS fails', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-receive-commit-failure-'));
    const packFilePath = join(activeServerDir, 'pack.bin');
    const payload = Buffer.from('verified blob whose CAS commit fails\n', 'utf8');
    const digest = createSha256Digest(payload);

    try {
      await writeBlobPackFile({
        filePath: packFilePath,
        blobs: [{ digest, content: payload }],
      });
      const {
        createWorkspaceReplicationPaths,
      } = await import('../state/workspaceReplicationPaths');
      const {
        receiveWorkspaceReplicationBlobPack,
      } = await import('./receiveBlobPack');
      const paths = createWorkspaceReplicationPaths({
        activeServerDir,
      });
      const commitFailure = new Error('simulated CAS commit failure');
      mkdirFailurePathPrefix = paths.casDirectory;
      mkdirFailure = commitFailure;

      const outcome = await receiveWorkspaceReplicationBlobPack({
        activeServerDir,
        jobId: 'job_transport_receive_commit_failure',
        packId: 'pack_commit_failure',
        packFilePath,
        maxSingleBlobBytes: 1024,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBe(commitFailure);
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
      } = await import('./receiveBlobPack');
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
