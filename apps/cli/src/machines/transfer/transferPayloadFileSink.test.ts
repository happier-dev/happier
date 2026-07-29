import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let failFirstRenameWith: NodeJS.ErrnoException['code'] | null = null;
let maxWriteBytesPerCall: number | null = null;
let forceZeroProgressWrite = false;
let failDestinationPublication = false;
let failBackupRestore = false;
let temporaryPath: string | null = null;
let backupPath: string | null = null;
let publicationFailure: Error | null = null;
let restoreFailure: Error | null = null;

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
    copyFile: vi.fn(async (...args: Parameters<typeof actual.copyFile>) => {
      if (failDestinationPublication && args[0] === temporaryPath) {
        publicationFailure = new Error('simulated staged destination copy failure');
        throw publicationFailure;
      }
      await actual.copyFile(...args);
    }),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const write = handle.write.bind(handle) as BufferFileWrite;
      Object.defineProperty(handle, 'write', {
        configurable: true,
        value: async (
          buffer: Uint8Array,
          offset = 0,
          length = buffer.byteLength - offset,
          position: number | null = null,
        ) => {
          if (forceZeroProgressWrite) {
            return { bytesWritten: 0, buffer };
          }
          return await write(
            buffer,
            offset,
            maxWriteBytesPerCall === null ? length : Math.min(length, maxWriteBytesPerCall),
            position,
          );
        },
      });
      return handle as FileHandle;
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (failFirstRenameWith !== null) {
        const code = failFirstRenameWith;
        failFirstRenameWith = null;
        temporaryPath = from;
        const error = new Error(`${code}: simulated Windows destination replacement failure`) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
      if (failBackupRestore && from === backupPath) {
        restoreFailure = new Error('simulated destination backup restoration failure');
        throw restoreFailure;
      }
      await actual.rename(from, to);
      if (to.includes('.happier-upload-backup-')) {
        backupPath = to;
      }
    }),
  };
});

import { createTransferPayloadFileSink } from './transferPayloadFileSink';
import { CrossDeviceMoveSourceCleanupError } from '@/utils/fs/moveFileWithCrossDeviceFallback';

describe('transferPayloadFileSink', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    failFirstRenameWith = null;
    maxWriteBytesPerCall = null;
    forceZeroProgressWrite = false;
    failDestinationPublication = false;
    failBackupRestore = false;
    temporaryPath = null;
    backupPath = null;
    publicationFailure = null;
    restoreFailure = null;
    vi.clearAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes every payload byte before committing its hash and size when the filesystem short-writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-transfer-file-sink-short-write-'));
    tempDirs.push(root);
    const destinationPath = join(root, 'payload.bin');
    const sink = await createTransferPayloadFileSink({ destinationPath });
    const payload = Buffer.from('short-write-payload');
    const manifestHash = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    maxWriteBytesPerCall = 3;

    await sink.appendChunk(payload);
    await expect(sink.finalize(manifestHash)).resolves.toEqual({
      destinationPath,
      manifestHash,
      sizeBytes: payload.length,
    });

    expect(await readFile(destinationPath)).toEqual(payload);
  });

  it('rejects a zero-progress filesystem write instead of falsely committing the chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-transfer-file-sink-zero-write-'));
    tempDirs.push(root);
    const destinationPath = join(root, 'payload.bin');
    const sink = await createTransferPayloadFileSink({ destinationPath });
    forceZeroProgressWrite = true;

    await expect(sink.appendChunk(Buffer.from('payload'))).rejects.toThrow('made no progress');
    await sink.abort();

    expect(await readdir(root)).toEqual([]);
  });

  it.each(['EPERM', 'EEXIST'] as const)(
    'replaces an existing destination when Windows-style rename fails with %s',
    async (renameErrorCode) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-transfer-file-sink-replace-'));
      tempDirs.push(root);
      const destinationPath = join(root, 'payload.bin');
      await writeFile(destinationPath, 'old-payload');
      const sink = await createTransferPayloadFileSink({ destinationPath });
      const payload = Buffer.from('new-payload');
      const manifestHash = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
      await sink.appendChunk(payload);
      failFirstRenameWith = renameErrorCode;

      await expect(sink.finalize(manifestHash)).resolves.toEqual({
        destinationPath,
        manifestHash,
        sizeBytes: payload.length,
      });

      expect(await readFile(destinationPath, 'utf8')).toBe('new-payload');
      expect(await readdir(root)).toEqual(['payload.bin']);
    },
  );

  it('preserves the temporary source and typed recovery state when destination restoration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-transfer-file-sink-rollback-failure-'));
    tempDirs.push(root);
    const destinationPath = join(root, 'payload.bin');
    await writeFile(destinationPath, 'old-payload');
    const sink = await createTransferPayloadFileSink({ destinationPath });
    const payload = Buffer.from('new-payload');
    const manifestHash = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    await sink.appendChunk(payload);
    failFirstRenameWith = 'EXDEV';
    failDestinationPublication = true;
    failBackupRestore = true;

    const outcome = await sink.finalize(manifestHash).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(CrossDeviceMoveSourceCleanupError);
    expect(temporaryPath).not.toBeNull();
    expect(backupPath).not.toBeNull();
    expect(outcome).toMatchObject({
      sourcePath: temporaryPath,
      destPath: destinationPath,
      backupPath,
      destinationRolledBack: false,
    });
    if (!(outcome instanceof CrossDeviceMoveSourceCleanupError)) {
      throw new Error('Expected typed cross-device move recovery failure');
    }
    expect(outcome.cause).toBeInstanceOf(AggregateError);
    if (!(outcome.cause instanceof AggregateError)) {
      throw new Error('Expected ordered publication and restoration failures');
    }
    expect(outcome.cause.errors).toEqual([publicationFailure, restoreFailure]);
    await expect(readFile(temporaryPath!)).resolves.toEqual(payload);
    await expect(readFile(backupPath!, 'utf8')).resolves.toBe('old-payload');
  });

  it('removes the partial file and preserves an existing destination on manifest mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-transfer-file-sink-mismatch-'));
    tempDirs.push(root);
    const destinationPath = join(root, 'payload.bin');
    await writeFile(destinationPath, 'old-payload');
    const sink = await createTransferPayloadFileSink({ destinationPath });
    await sink.appendChunk(Buffer.from('invalid-payload'));

    await expect(sink.finalize(`sha256:${'0'.repeat(64)}`)).rejects.toThrow('Transfer payload manifest mismatch');

    expect(await readFile(destinationPath, 'utf8')).toBe('old-payload');
    expect(await readdir(root)).toEqual(['payload.bin']);
  });

  it('does not replace an existing destination directory during Windows-style recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-transfer-file-sink-directory-'));
    tempDirs.push(root);
    const destinationPath = join(root, 'payload.bin');
    await mkdir(destinationPath);
    await writeFile(join(destinationPath, 'keep.txt'), 'keep-me');
    const sink = await createTransferPayloadFileSink({ destinationPath });
    const payload = Buffer.from('new-payload');
    const manifestHash = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    await sink.appendChunk(payload);
    failFirstRenameWith = 'EPERM';

    await expect(sink.finalize(manifestHash)).rejects.toThrow();

    expect(await readFile(join(destinationPath, 'keep.txt'), 'utf8')).toBe('keep-me');
    expect(await readdir(root)).toEqual(['payload.bin']);
  });

  it('removes the partial file when the transfer is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-transfer-file-sink-abort-'));
    tempDirs.push(root);
    const destinationPath = join(root, 'payload.bin');
    const sink = await createTransferPayloadFileSink({ destinationPath });
    await sink.appendChunk(Buffer.from('partial-payload'));

    await sink.abort();

    expect(await readdir(root)).toEqual([]);
  });
});
