import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  publishProtectedLocalStateFileIfAbsent,
  readProtectedLocalStateFile,
  readProtectedLocalStateFileSync,
  type ProtectedLocalStateOptions,
  writeProtectedLocalStateFileAtomic,
} from './protectedLocalState';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
});

describe('protected local state', () => {
  it('protects the directory and empty temporary file before atomically publishing secret bytes on Windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-protected-local-state-'));
    roots.push(root);
    const path = join(root, 'state', 'secret.json');
    const events: string[] = [];
    const options: ProtectedLocalStateOptions = {
      platform: 'win32',
      windowsAclBoundary: {
        async applyAndVerify({ path: protectedPath, kind }) {
          if (kind === 'directory') {
            events.push(`directory-protected:${protectedPath}`);
            return;
          }
          await expect(readFile(protectedPath, 'utf8')).resolves.toBe('');
          events.push(`temporary-protected-empty:${protectedPath}`);
        },
        async verify({ path: verifiedPath, kind }) {
          if (kind === 'directory') {
            events.push(`directory-verified:${verifiedPath}`);
            return;
          }
          await expect(readFile(verifiedPath, 'utf8')).resolves.toBe('secret');
          events.push(verifiedPath === path
            ? 'published-secret-verified'
            : `temporary-secret-verified:${verifiedPath}`);
        },
      },
    };

    await writeProtectedLocalStateFileAtomic(path, 'secret', options);

    const temporaryProtected = events.findIndex((event) => event.startsWith('temporary-protected-empty:'));
    const temporaryVerified = events.findIndex((event) => event.startsWith('temporary-secret-verified:'));
    const publishedVerified = events.indexOf('published-secret-verified');
    expect(events.findIndex((event) => event.startsWith('directory-protected:'))).toBeGreaterThanOrEqual(0);
    expect(temporaryProtected).toBeGreaterThanOrEqual(0);
    expect(temporaryVerified).toBeGreaterThan(temporaryProtected);
    expect(publishedVerified).toBeGreaterThan(temporaryVerified);
  });

  it('refuses an inherited Windows directory ACL before creating a secret file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-protected-local-state-unsafe-'));
    roots.push(root);
    const directory = join(root, 'state');
    const path = join(directory, 'secret.json');
    await mkdir(directory, { recursive: true, mode: 0o700 });

    await expect(writeProtectedLocalStateFileAtomic(path, 'secret', {
      platform: 'win32',
      windowsAclBoundary: {
        async applyAndVerify() {
          throw new Error('must not repair an existing inherited ACL implicitly');
        },
        async verify() {
          throw new Error('inherited ACL');
        },
      },
    })).rejects.toThrow('inherited ACL');

    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

const posixOnly = process.platform !== 'win32';

async function protectedFileIn(directoryMode: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-protected-local-state-read-'));
  roots.push(root);
  const directory = join(root, 'state');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'secret.json');
  await writeFile(path, 'secret', { mode: 0o600 });
  await chmod(directory, directoryMode);
  return path;
}

describe('protected local state reads', () => {
  it.runIf(posixOnly)('refuses to disclose bytes from a group- or world-reachable directory', async () => {
    const path = await protectedFileIn(0o755);

    await expect(readProtectedLocalStateFile(path))
      .rejects.toThrow('Protected local state has unsafe group/world permissions');
    expect(() => readProtectedLocalStateFileSync(path))
      .toThrow('Protected local state has unsafe group/world permissions');

    await chmod(dirname(path), 0o700);
    await expect(readProtectedLocalStateFile(path)).resolves.toBe('secret');
    expect(readProtectedLocalStateFileSync(path)).toBe('secret');
  });

  it.runIf(posixOnly)('refuses to disclose bytes from a directory owned by another user', async () => {
    const path = await protectedFileIn(0o700);
    const ownerUid = (await stat(path)).uid;

    await expect(readProtectedLocalStateFile(path, { expectedUid: ownerUid + 1 }))
      .rejects.toThrow('Protected local state has an unexpected owner UID');
    expect(() => readProtectedLocalStateFileSync(path, { expectedUid: ownerUid + 1 }))
      .toThrow('Protected local state has an unexpected owner UID');
  });

  it.runIf(posixOnly)('refuses a symbolic link standing in for the protected file', async () => {
    const path = await protectedFileIn(0o700);
    const link = join(dirname(path), 'link.json');
    await symlink(path, link);

    await expect(readProtectedLocalStateFile(link))
      .rejects.toThrow('Protected local state must not be a symbolic link');
    expect(() => readProtectedLocalStateFileSync(link))
      .toThrow('Protected local state must not be a symbolic link');
  });

  it('verifies the Windows file ACL before disclosing bytes, synchronously and not', async () => {
    const path = await protectedFileIn(0o700);
    const verified: string[] = [];

    await expect(readProtectedLocalStateFile(path, {
      platform: 'win32',
      windowsAclBoundary: {
        async applyAndVerify() { throw new Error('a read must not repair an ACL'); },
        async verify({ kind }) { verified.push(`async:${kind}`); throw new Error('inherited ACL'); },
      },
    })).rejects.toThrow('inherited ACL');

    expect(() => readProtectedLocalStateFileSync(path, {
      platform: 'win32',
      windowsAclBoundarySync: {
        applyAndVerify() { throw new Error('a read must not repair an ACL'); },
        verify({ kind }) { verified.push(`sync:${kind}`); throw new Error('inherited ACL'); },
      },
    })).toThrow('inherited ACL');

    expect(verified).toEqual(['async:file', 'sync:file']);
  });
});

describe('protected local state publication', () => {
  it('publishes complete bytes once and reports the loser without disturbing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-protected-local-state-publish-'));
    roots.push(root);
    const path = join(root, 'state', 'device-key');

    await expect(publishProtectedLocalStateFileIfAbsent(path, 'first')).resolves.toBe(true);
    await expect(publishProtectedLocalStateFileIfAbsent(path, 'second')).resolves.toBe(false);

    await expect(readFile(path, 'utf8')).resolves.toBe('first');
    if (posixOnly) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await expect(readdir(dirname(path))).resolves.toEqual(['device-key']);
  });

  it.runIf(posixOnly)('re-applies the protected shape when an owner replaces a file an older release left loose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-protected-local-state-owned-'));
    roots.push(root);
    const directory = join(root, 'state');
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const path = join(directory, 'secret.json');
    await writeFile(path, 'stale', { mode: 0o644 });

    await expect(writeProtectedLocalStateFileAtomic(path, 'fresh'))
      .rejects.toThrow('Protected local state has unsafe group/world permissions');

    await writeProtectedLocalStateFileAtomic(path, 'fresh', { authority: 'owned' });

    await expect(readFile(path, 'utf8')).resolves.toBe('fresh');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
