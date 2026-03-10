import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveOpenCodeServerLockTimeoutMsFromEnv, withOpenCodeServerFileLock } from './openCodeServerFileLock';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('withOpenCodeServerFileLock', () => {
  it('defaults the lock timeout to the larger managed-server startup timeout when unset', () => {
    expect(resolveOpenCodeServerLockTimeoutMsFromEnv({
      HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS: '30000',
    })).toBe(30_000);
    expect(resolveOpenCodeServerLockTimeoutMsFromEnv({
      HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS: '15000',
    })).toBe(20_000);
  });

  it('removes a lock left behind by a dead pid and proceeds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-'));
    try {
      const lockFile = join(dir, 'opencode.lock');
      await writeFile(lockFile, JSON.stringify({ pid: 999_999, createdAtMs: Date.now() }), 'utf8');
      expect(await pathExists(lockFile)).toBe(true);

      process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS = '50';
      process.env.HAPPIER_OPENCODE_SERVER_LOCK_STALE_AFTER_MS = '600000';

      const ran = await withOpenCodeServerFileLock(lockFile, async () => {
        return true;
      });

      expect(ran).toBe(true);
      expect(await pathExists(lockFile)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS;
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_STALE_AFTER_MS;
    }
  });

  it('waits for an active lock to release within timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-'));
    try {
      const lockFile = join(dir, 'opencode.lock');

      process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS = '1000';

      const events: string[] = [];
      await Promise.all([
        withOpenCodeServerFileLock(lockFile, async () => {
          events.push('first:entered');
          await new Promise((r) => setTimeout(r, 120));
          events.push('first:exiting');
        }),
        (async () => {
          // Ensure the first lock has a chance to create the file.
          await new Promise((r) => setTimeout(r, 10));
          await withOpenCodeServerFileLock(lockFile, async () => {
            events.push('second:entered');
          });
        })(),
      ]);

      expect(events).toEqual(['first:entered', 'first:exiting', 'second:entered']);
      expect(await pathExists(lockFile)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS;
    }
  });

  it('times out when lock pid is alive and not stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-'));
    try {
      const lockFile = join(dir, 'opencode.lock');
      await writeFile(lockFile, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');

      process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS = '50';
      process.env.HAPPIER_OPENCODE_SERVER_LOCK_STALE_AFTER_MS = '600000';

      await expect(withOpenCodeServerFileLock(lockFile, async () => {})).rejects.toThrow(
        'Timeout acquiring OpenCode server lock after 50ms',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS;
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_STALE_AFTER_MS;
    }
  });

  it('breaks a stale/invalid lock file even when it has no pid metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-'));
    try {
      const lockFile = join(dir, 'opencode.lock');
      await writeFile(lockFile, '', 'utf8');
      // Make it clearly "not actively being written" so the lock can be broken safely.
      const nowSeconds = Date.now() / 1000;
      await utimes(lockFile, nowSeconds - 60, nowSeconds - 60);

      process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS = '100';
      process.env.HAPPIER_OPENCODE_SERVER_LOCK_STALE_AFTER_MS = '600000';

      const ran = await withOpenCodeServerFileLock(lockFile, async () => true);
      expect(ran).toBe(true);
      expect(await pathExists(lockFile)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS;
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_STALE_AFTER_MS;
    }
  });

  it('creates the parent directory for the lock file when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-'));
    try {
      const lockFile = join(dir, 'missing', 'opencode.lock');

      process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS = '250';

      const ran = await withOpenCodeServerFileLock(lockFile, async () => true);
      expect(ran).toBe(true);
      expect(await pathExists(lockFile)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS;
    }
  });

  it('fails fast on non-lock filesystem errors (e.g. EISDIR)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-'));
    try {
      const lockFile = join(dir, 'opencode.lock');
      // Make the "lock file" path a directory to force EISDIR on open('wx').
      await rm(lockFile, { recursive: true, force: true });
      await mkdir(lockFile, { recursive: true });

      process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS = '250';

      await expect(withOpenCodeServerFileLock(lockFile, async () => {})).rejects.toThrow(
        'Failed to acquire OpenCode server lock: EISDIR',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS;
    }
  });
});
