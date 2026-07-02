import { chmod, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareZellijSocketDir, resolveZellijSocketDir } from './socketDir';

describe('zellij socket directory', () => {
  it('uses the happy home for short paths and hashes long POSIX paths under tmp', () => {
    expect(resolveZellijSocketDir('/home/test/.happier')).toBe(join('/home/test/.happier', 'zellij-sock'));

    const longHome = join('/tmp', 'happier-'.repeat(30));
    const socketDir = resolveZellijSocketDir(longHome);
    if (process.platform === 'win32') {
      expect(socketDir).toBe(join(longHome, 'zellij-sock'));
    } else {
      expect(socketDir).toMatch(/^\/tmp\/happier-zellij-[a-f0-9]{16}$/);
    }
  });

  it('creates owner-only socket directories on POSIX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-zellij-socket-'));
    const socketDir = join(root, 'socket');

    await prepareZellijSocketDir(socketDir);

    const info = await stat(socketDir);
    expect(info.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(info.mode & 0o077).toBe(0);

      await chmod(socketDir, 0o777);
      await prepareZellijSocketDir(socketDir);
      expect((await stat(socketDir)).mode & 0o077).toBe(0);
    }
  });
});
