import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hashPrivateBearer,
  readPrivateOwnerFile,
  readPrivateOwnerFileSync,
  readPrivateBearerFile,
  removePrivateBearerFile,
  replacePrivateBearerFile,
  verifyPrivateBearer,
  writePrivateBearerFile,
  writePrivateOwnerFile,
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
  it('reads a stable owner-private file through the CLI-owned helper', async () => {
    const root = await createTempDir();
    const path = join(root, 'private', 'owner.json');
    await writePrivateOwnerFile({ path, contents: '{"v":1}\n' });

    expect(readPrivateOwnerFileSync(path)).toBe('{"v":1}\n');
    await expect(readPrivateOwnerFile(path)).resolves.toBe('{"v":1}\n');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects unsafe owner-file permissions and symlink substitution',
    async () => {
      const root = await createTempDir();
      const path = join(root, 'private', 'owner.json');
      await writePrivateOwnerFile({ path, contents: '{"v":1}\n' });

      await chmod(path, 0o644);
      expect(() => readPrivateOwnerFileSync(path)).toThrow('private_owner_file_unsafe');

      await chmod(path, 0o600);
      const target = join(root, 'private', 'target.json');
      await writeFile(target, '{"v":2}\n', { mode: 0o600 });
      await rm(path);
      await symlink(target, path);
      await expect(readPrivateOwnerFile(path)).rejects.toThrow('private_owner_file_unsafe');
    },
  );

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

  it('writes owner-private binary files without changing their bytes', async () => {
    const root = await createTempDir();
    const path = join(root, 'materialized', 'credential.bin');
    const contents = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x0a]);

    await writePrivateOwnerFile({ path, contents });

    await expect(readFile(path)).resolves.toEqual(Buffer.from(contents));
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'materialized'))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('preserves a missing-file error while rejecting other filesystem failures as unsafe', async () => {
    const root = await createTempDir();
    const missingPath = join(root, 'missing.json');

    await expect(readPrivateBearerFile(missingPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const notDirectory = join(root, 'not-a-directory');
    await writeFile(notDirectory, 'not a directory', { mode: 0o600 });
    await expect(readPrivateBearerFile(join(notDirectory, 'bearer.json'))).rejects.toThrow(
      'private_bearer_file_unsafe',
    );

    if (process.platform !== 'win32') {
      const danglingSymlink = join(root, 'dangling-symlink.json');
      await symlink(join(root, 'absent-target.json'), danglingSymlink);
      await expect(readPrivateBearerFile(danglingSymlink)).rejects.toThrow(
        'private_bearer_file_unsafe',
      );
    }
  });

  it.runIf(process.platform !== 'win32' && typeof process.getuid === 'function')(
    'refuses to create a private file in a directory owned by another user',
    async () => {
      const root = await createTempDir();
      const path = join(root, 'bearer.json');
      const getuid = process.getuid;
      if (!getuid) throw new Error('expected process.getuid on this platform');
      const currentUid = getuid();
      const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
      if (!getuidDescriptor) throw new Error('expected an own process.getuid property');
      Object.defineProperty(process, 'getuid', {
        ...getuidDescriptor,
        value: () => currentUid + 1,
      });
      try {
        await expect(
          writePrivateBearerFile({ path, contents: '{"v":1}\n' }),
        ).rejects.toThrow('private_bearer_parent_unsafe');
      } finally {
        Object.defineProperty(process, 'getuid', getuidDescriptor);
      }
    },
  );

  it('refuses to write a bearer file on Windows when the protected DACL cannot be proven', async () => {
    const root = await createTempDir();
    const path = join(root, 'capabilities', 'bearer.json');
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('expected an own process.platform property');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    try {
      // Bearer files now share the one protected-state owner, so Windows runs
      // its ACL boundary instead of skipping the POSIX mode and guaranteeing
      // nothing. This host cannot run that boundary, so the write must fail
      // closed rather than publish an unprotected credential.
      await expect(writePrivateBearerFile({ path, contents: '{"v":1}\n' }))
        .rejects.toThrow('private_bearer_parent_unsafe');
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }

    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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
