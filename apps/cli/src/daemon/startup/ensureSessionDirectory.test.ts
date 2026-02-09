import fs from 'fs/promises';
import os from 'os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureSessionDirectory } from './ensureSessionDirectory';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'happier-ensure-dir-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe('ensureSessionDirectory', () => {
  it('returns existing directory without creating it again', async () => {
    const root = await createTempRoot();
    const directory = join(root, 'existing');
    await fs.mkdir(directory, { recursive: true });

    const result = await ensureSessionDirectory({
      directory,
      approvedNewDirectoryCreation: true,
    });

    expect(result).toEqual({ ok: true, directoryCreated: false });
  });

  it('requests approval when directory is missing and creation is not approved', async () => {
    const root = await createTempRoot();
    const directory = join(root, 'new-dir');

    const result = await ensureSessionDirectory({
      directory,
      approvedNewDirectoryCreation: false,
    });

    expect(result).toEqual({
      ok: false,
      response: {
        type: 'requestToApproveDirectoryCreation',
        directory,
      },
    });
  });

  it('creates missing directory when approved', async () => {
    const root = await createTempRoot();
    const directory = join(root, 'missing', 'nested');

    const result = await ensureSessionDirectory({
      directory,
      approvedNewDirectoryCreation: true,
    });

    expect(result).toEqual({ ok: true, directoryCreated: true });
    await expect(fs.access(directory)).resolves.toBeUndefined();
  });

  it('returns a descriptive ENOTDIR error when a parent path is a file', async () => {
    const root = await createTempRoot();
    const parentFile = join(root, 'not-a-dir');
    await fs.writeFile(parentFile, 'x');

    const result = await ensureSessionDirectory({
      directory: join(parentFile, 'child'),
      approvedNewDirectoryCreation: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected directory creation to fail');
    }

    expect(result.response.type).toBe('error');
    if (result.response.type === 'error') {
      expect(result.response.errorCode).toBe('DIRECTORY_CREATE_FAILED');
      expect(result.response.errorMessage).toContain('Cannot create a directory here');
    }
  });
});
