import { mkdtemp, readFile, readdir, rename as renameMock, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let initialRenameErrorCode: NodeJS.ErrnoException['code'] | null = null;
let failCopyFromPath: string | null = null;
let failBackupRestore = false;
let backupPath: string | null = null;
let copyFailure: Error | null = null;
let restoreFailure: Error | null = null;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    copyFile: vi.fn(async (...args: Parameters<typeof actual.copyFile>) => {
      if (args[0] === failCopyFromPath) {
        copyFailure = new Error('simulated staged destination copy failure');
        throw copyFailure;
      }
      await actual.copyFile(...args);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (initialRenameErrorCode !== null) {
        const code = initialRenameErrorCode;
        initialRenameErrorCode = null;
        const error = new Error('simulated cross-device rename') as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
      if (failBackupRestore && backupPath === from) {
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

import {
  CrossDeviceMoveSourceCleanupError,
  moveFileWithCrossDeviceFallback,
} from './moveFileWithCrossDeviceFallback';

describe('moveFileWithCrossDeviceFallback', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    initialRenameErrorCode = null;
    failCopyFromPath = null;
    failBackupRestore = false;
    backupPath = null;
    copyFailure = null;
    restoreFailure = null;
    vi.clearAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reports typed recovery state and ordered causes when destination restoration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-cross-device-rollback-'));
    tempDirs.push(root);
    const sourcePath = join(root, 'source.tmp');
    const destPath = join(root, 'destination.txt');
    await writeFile(sourcePath, 'incoming-payload', 'utf8');
    await writeFile(destPath, 'original-destination', 'utf8');
    initialRenameErrorCode = 'EXDEV';
    failCopyFromPath = sourcePath;
    failBackupRestore = true;

    const outcome = await moveFileWithCrossDeviceFallback(sourcePath, destPath).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(CrossDeviceMoveSourceCleanupError);
    expect(outcome).toMatchObject({
      sourcePath,
      destPath,
      backupPath,
      destinationRolledBack: false,
    });
    if (!(outcome instanceof CrossDeviceMoveSourceCleanupError)) {
      throw new Error('Expected typed cross-device move recovery failure');
    }
    expect(outcome.cause).toBeInstanceOf(AggregateError);
    if (!(outcome.cause instanceof AggregateError)) {
      throw new Error('Expected ordered primary and restoration failures');
    }
    expect(outcome.cause.errors).toEqual([copyFailure, restoreFailure]);
    expect(await readFile(sourcePath, 'utf8')).toBe('incoming-payload');
    expect(backupPath).not.toBeNull();
    await expect(readFile(backupPath!, 'utf8')).resolves.toBe('original-destination');
    expect(await readdir(root)).toEqual(expect.arrayContaining([
      'source.tmp',
      expect.stringContaining('.happier-upload-backup-destination.txt.'),
    ]));
    expect(renameMock).toHaveBeenCalledWith(backupPath, destPath);
  });
});
