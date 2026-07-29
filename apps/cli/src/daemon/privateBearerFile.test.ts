import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hashPrivateBearer,
  readPrivateBearerFile,
  removePrivateBearerFile,
  replacePrivateBearerFile,
  verifyPrivateBearer,
  writePrivateBearerFile,
} from './privateBearerFile';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-private-bearer-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('private bearer file primitives', () => {
  it('hashes and verifies bearer values without exposing timing-sensitive equality', () => {
    const expectedHash = hashPrivateBearer('secret-a');

    expect(expectedHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(verifyPrivateBearer({ provided: 'secret-a', expectedHash })).toBe(true);
    expect(verifyPrivateBearer({ provided: 'secret-b', expectedHash })).toBe(false);
    expect(verifyPrivateBearer({ provided: 'secret-a', expectedHash: 'invalid' })).toBe(false);
  });

  it('creates an owner-private file exclusively and never overwrites it', async () => {
    const root = await createTempDir();
    const path = join(root, 'capabilities', 'bearer.json');

    await writePrivateBearerFile({ path, contents: '{"v":1}\n' });

    await expect(readFile(path, 'utf8')).resolves.toBe('{"v":1}\n');
    await expect(readPrivateBearerFile(path)).resolves.toBe('{"v":1}\n');
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'capabilities'))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await expect(writePrivateBearerFile({ path, contents: '{"v":2}\n' })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await expect(readPrivateBearerFile(path)).rejects.toThrow(
        'private_bearer_file_unsafe',
      );
    }
  });

  it('atomically replaces a private file and removes it idempotently', async () => {
    const root = await createTempDir();
    const path = join(root, 'capabilities', 'bearer.json');

    await replacePrivateBearerFile({ path, contents: 'first\n' });
    await replacePrivateBearerFile({ path, contents: 'second\n' });

    await expect(readFile(path, 'utf8')).resolves.toBe('second\n');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await removePrivateBearerFile(path);
    await removePrivateBearerFile(path);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
