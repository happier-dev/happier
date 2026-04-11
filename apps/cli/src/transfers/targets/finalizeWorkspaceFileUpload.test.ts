import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { access, rm, rename as renameMock } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let renameAttemptCount = 0;
let failingRmPath: string | null = null;
let failingRmCode: string | null = null;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const actualRename = actual.rename;
  const actualRm = actual.rm;

  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      renameAttemptCount += 1;
      if (renameAttemptCount === 1) {
        const error = new Error('cross-device rename') as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      }
      await actualRename(from, to);
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
    failingRmPath = null;
    failingRmCode = null;
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
});
