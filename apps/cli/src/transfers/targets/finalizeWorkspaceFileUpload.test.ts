import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { access, copyFile as copyFileMock, rm, rename as renameMock } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TransferSessionStore } from '../core/transferSessionStore';
import {
  createTransferSessionLifecycle,
  finalizeUploadTransferSession,
  openUploadTransferSession,
  writeUploadTransferChunk,
} from '../core/transferSessionLifecycle';

let renameAttemptCount = 0;
let firstRenameErrorCode: string | null = 'EXDEV';
let failingRmPath: string | null = null;
let failingRmCode: string | null = null;
let createDestinationBeforeExclusiveCopy = false;
let failingCopyFromPath: string | null = null;
let failBackupRestore = false;
let backupPath: string | null = null;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const actualRename = actual.rename;
  const actualRm = actual.rm;
  const actualCopyFile = actual.copyFile;

  return {
    ...actual,
    copyFile: vi.fn(async (from: string, to: string, mode?: number) => {
      if (from === failingCopyFromPath) {
        throw new Error('simulated staged destination copy failure');
      }
      if (createDestinationBeforeExclusiveCopy) {
        createDestinationBeforeExclusiveCopy = false;
        writeFileSync(to, 'raced-destination', 'utf8');
      }
      await actualCopyFile(from, to, mode);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      renameAttemptCount += 1;
      if (renameAttemptCount === 1 && firstRenameErrorCode) {
        const error = new Error('cross-device rename') as NodeJS.ErrnoException;
        error.code = firstRenameErrorCode;
        throw error;
      }
      if (failBackupRestore && backupPath === from) {
        throw new Error('simulated destination backup restoration failure');
      }
      await actualRename(from, to);
      if (to.includes('.happier-upload-backup-')) {
        backupPath = to;
      }
    }),
    rm: vi.fn(async (targetPath: string, options?: Parameters<typeof actualRm>[1]) => {
      if (failingRmPath === targetPath && failingRmCode) {
        const error = new Error('remove blocked') as NodeJS.ErrnoException;
        error.code = failingRmCode;
        failingRmCode = null;
        throw error;
      }
      await actualRm(targetPath, options);
    }),
  };
});

import { finalizeWorkspaceFileUpload } from './finalizeWorkspaceFileUpload';

describe('finalizeWorkspaceFileUpload', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    renameAttemptCount = 0;
    firstRenameErrorCode = 'EXDEV';
    failingRmPath = null;
    failingRmCode = null;
    createDestinationBeforeExclusiveCopy = false;
    failingCopyFromPath = null;
    failBackupRestore = false;
    backupPath = null;
    vi.clearAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('survives EXDEV when promoting the uploaded file into place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-finalize-upload-'));
    tempDirs.push(root);
    const tempPath = join(root, 'temp.txt');
    const destPath = join(root, 'dest', 'file.txt');
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(tempPath, 'payload', 'utf8');

    const result = await finalizeWorkspaceFileUpload({
      tempPath,
      destPath,
      destDisplayPath: '~/dest/file.txt',
      overwrite: true,
      sizeBytes: 7,
    });

    expect(result).toEqual({
      success: true,
      path: '~/dest/file.txt',
      sizeBytes: 7,
    });
    expect(readFileSync(destPath, 'utf8')).toBe('payload');
    await expect(access(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a retryable failure and preserves the existing destination when staged temp cleanup fails after EXDEV copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-finalize-upload-'));
    tempDirs.push(root);
    const tempPath = join(root, 'temp.txt');
    const destPath = join(root, 'dest', 'file.txt');
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, 'original-destination', 'utf8');
    writeFileSync(tempPath, 'payload', 'utf8');
    failingRmPath = tempPath;
    failingRmCode = 'EPERM';

    const result = await finalizeWorkspaceFileUpload({
      tempPath,
      destPath,
      destDisplayPath: '~/dest/file.txt',
      overwrite: true,
      sizeBytes: 7,
    });

    expect(result).toEqual({
      success: false,
      error: 'Failed to finalize uploaded file because the staged upload file is still in use. Retry the upload finalization.',
      keepSession: true,
    });
    expect(readFileSync(destPath, 'utf8')).toBe('original-destination');
    expect(readFileSync(tempPath, 'utf8')).toBe('payload');
  });

  it('classifies incomplete destination restoration as retained recovery state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-finalize-upload-rollback-failure-'));
    tempDirs.push(root);
    const tempPath = join(root, 'temp.txt');
    const destPath = join(root, 'dest', 'file.txt');
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, 'original-destination', 'utf8');
    writeFileSync(tempPath, 'payload', 'utf8');
    failingCopyFromPath = tempPath;
    failBackupRestore = true;

    await expect(finalizeWorkspaceFileUpload({
      tempPath,
      destPath,
      destDisplayPath: '~/dest/file.txt',
      overwrite: true,
      sizeBytes: 7,
    })).resolves.toEqual({
      success: false,
      error: 'Failed to finalize uploaded file because destination recovery was incomplete. Recovery files were preserved; inspect the destination before retrying.',
      errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
      keepSession: true,
    });

    expect(readFileSync(tempPath, 'utf8')).toBe('payload');
    expect(backupPath).not.toBeNull();
    expect(readFileSync(backupPath!, 'utf8')).toBe('original-destination');
  });

  it('keeps the real upload session attached when destination restoration fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-finalize-upload-session-retention-'));
    tempDirs.push(root);
    const destPath = join(root, 'dest', 'file.txt');
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, 'original-destination', 'utf8');
    const store = new TransferSessionStore({
      ttlMs: 10_000,
      tempRoot: join(root, 'transfer-sessions'),
    });
    const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 8 });
    const payload = Buffer.from('payload', 'utf8');

    try {
      const session = await openUploadTransferSession({
        lifecycle,
        target: {
          destPath,
          destDisplayPath: '~/dest/file.txt',
          overwrite: true,
          expectedSizeBytes: payload.length,
          finalizeUpload: async (input) => await finalizeWorkspaceFileUpload({
            tempPath: input.tempPath,
            destPath,
            destDisplayPath: '~/dest/file.txt',
            overwrite: true,
            sizeBytes: input.sizeBytes,
          }),
        },
      });
      await expect(writeUploadTransferChunk({
        lifecycle,
        uploadId: session.uploadId,
        index: 0,
        contentBase64: payload.toString('base64'),
      })).resolves.toEqual({ success: true });
      const storedSession = store.getUploadSession(session.uploadId);
      if (!storedSession) {
        throw new Error('Expected active upload session');
      }
      failingCopyFromPath = storedSession.tempPath;
      failBackupRestore = true;

      await expect(finalizeUploadTransferSession({
        lifecycle,
        uploadId: session.uploadId,
      })).resolves.toEqual({
        success: false,
        error: 'Failed to finalize uploaded file because destination recovery was incomplete. Recovery files were preserved; inspect the destination before retrying.',
        errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
        keepSession: true,
      });

      expect(store.getUploadSession(session.uploadId)).toBe(storedSession);
      expect(readFileSync(storedSession.tempPath)).toEqual(payload);
      expect(backupPath).not.toBeNull();
      expect(readFileSync(backupPath!, 'utf8')).toBe('original-destination');
      await expect(writeUploadTransferChunk({
        lifecycle,
        uploadId: session.uploadId,
        index: 0,
        contentBase64: payload.toString('base64'),
      })).resolves.toEqual({ success: true });
    } finally {
      await store.dispose();
    }
  });

  it('retains recovery state when source cleanup and destination rollback both fail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-finalize-upload-cleanup-rollback-failure-'));
    tempDirs.push(root);
    const tempPath = join(root, 'temp.txt');
    const destPath = join(root, 'dest', 'file.txt');
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, 'original-destination', 'utf8');
    writeFileSync(tempPath, 'payload', 'utf8');
    failingRmPath = tempPath;
    failingRmCode = 'EPERM';
    failBackupRestore = true;

    await expect(finalizeWorkspaceFileUpload({
      tempPath,
      destPath,
      destDisplayPath: '~/dest/file.txt',
      overwrite: true,
      sizeBytes: 7,
    })).resolves.toEqual({
      success: false,
      error: 'Failed to finalize uploaded file because destination recovery was incomplete. Recovery files were preserved; inspect the destination before retrying.',
      errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
      keepSession: true,
    });

    expect(readFileSync(tempPath, 'utf8')).toBe('payload');
    expect(backupPath).not.toBeNull();
    expect(readFileSync(backupPath!, 'utf8')).toBe('original-destination');
    await expect(access(destPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['EPERM', 'EEXIST'] as const)('overwrites an existing destination when same-volume rename fails with %s', async (renameErrorCode) => {
    const root = mkdtempSync(join(tmpdir(), 'happier-finalize-upload-'));
    tempDirs.push(root);
    const tempPath = join(root, 'temp.txt');
    const destPath = join(root, 'dest', 'file.txt');
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, 'original-destination', 'utf8');
    writeFileSync(tempPath, 'payload', 'utf8');
    firstRenameErrorCode = renameErrorCode;

    const result = await finalizeWorkspaceFileUpload({
      tempPath,
      destPath,
      destDisplayPath: '~/dest/file.txt',
      overwrite: true,
      sizeBytes: 7,
    });

    expect(result).toEqual({
      success: true,
      path: '~/dest/file.txt',
      sizeBytes: 7,
    });
    expect(readFileSync(destPath, 'utf8')).toBe('payload');
    await expect(access(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite a destination created after the no-overwrite preflight check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-finalize-upload-race-'));
    tempDirs.push(root);
    const tempPath = join(root, 'temp.txt');
    const destPath = join(root, 'dest', 'file.txt');
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(tempPath, 'payload', 'utf8');
    firstRenameErrorCode = null;
    createDestinationBeforeExclusiveCopy = true;

    const result = await finalizeWorkspaceFileUpload({
      tempPath,
      destPath,
      destDisplayPath: '~/dest/file.txt',
      overwrite: false,
      sizeBytes: 7,
    });

    expect(result).toEqual({
      success: false,
      error: 'Destination already exists',
      keepSession: true,
    });
    expect(readFileSync(destPath, 'utf8')).toBe('raced-destination');
    expect(readFileSync(tempPath, 'utf8')).toBe('payload');
    expect(renameMock).not.toHaveBeenCalled();
    expect(copyFileMock).toHaveBeenCalled();
  });
});
