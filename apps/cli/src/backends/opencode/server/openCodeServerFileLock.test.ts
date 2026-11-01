import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
  it('serializes concurrent mutations nested under one bounded access owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-parallel-'));
    const lockFile = join(dir, 'opencode.lock');
    const stateFile = join(dir, 'state.json');
    try {
      await writeFile(stateFile, '0');
      const mutate = async () => await withOpenCodeServerFileLock(lockFile, async () => {
        const prior = Number(await readFile(stateFile, 'utf8'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await writeFile(stateFile, String(prior + 1));
      });
      await withOpenCodeServerFileLock(lockFile, async () => {
        await Promise.all([mutate(), mutate()]);
      });
      expect(await readFile(stateFile, 'utf8')).toBe('2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not reuse a lock from async work that outlived its owning callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-expired-'));
    const lockFile = join(dir, 'opencode.lock');
    let wakeEscaped!: () => void;
    let releaseCompetitor!: () => void;
    let enteredCompetitor!: () => void;
    const wake = new Promise<void>((resolve) => { wakeEscaped = resolve; });
    const competitorEntered = new Promise<void>((resolve) => { enteredCompetitor = resolve; });
    const competitorRelease = new Promise<void>((resolve) => { releaseCompetitor = resolve; });
    let escaped: Promise<void> = Promise.resolve();
    let competitor: Promise<void> = Promise.resolve();
    process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS = '50';
    try {
      await withOpenCodeServerFileLock(lockFile, async () => {
        escaped = (async () => {
          await wake;
          await withOpenCodeServerFileLock(lockFile, async () => {});
        })();
      });
      competitor = withOpenCodeServerFileLock(lockFile, async () => {
        enteredCompetitor();
        await competitorRelease;
      });
      await competitorEntered;
      wakeEscaped();
      await expect(escaped).rejects.toThrow('Timeout acquiring OpenCode server lock after 50ms');
    } finally {
      wakeEscaped();
      releaseCompetitor();
      await Promise.allSettled([escaped, competitor]);
      await rm(dir, { recursive: true, force: true });
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS;
    }
  });

  it('keeps one acquisition lock across nested work while excluding an unrelated concurrent operation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-lock-nested-'));
    const lockFile = join(dir, 'opencode.lock');
    let releaseOuter!: () => void;
    let enteredOuter!: () => void;
    const outerEntered = new Promise<void>((resolve) => { enteredOuter = resolve; });
    const outerRelease = new Promise<void>((resolve) => { releaseOuter = resolve; });
    const events: string[] = [];
    process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS = '100';
    try {
      const outer = withOpenCodeServerFileLock(lockFile, async () => {
        await withOpenCodeServerFileLock(lockFile, async () => { events.push('nested'); });
        enteredOuter();
        await outerRelease;
        events.push('outer-released');
      });
      // Before reentrancy exists this rejects from the nested acquisition, not a harness timeout.
      await Promise.race([outerEntered, outer]);
      const competing = withOpenCodeServerFileLock(lockFile, async () => { events.push('competing'); });
      expect(events).toEqual(['nested']);
      expect(await pathExists(lockFile)).toBe(true);
      releaseOuter();
      await Promise.all([outer, competing]);
      expect(events).toEqual(['nested', 'outer-released', 'competing']);
    } finally {
      releaseOuter();
      await rm(dir, { recursive: true, force: true });
      delete process.env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS;
    }
  });

  it('defaults the lock timeout beyond the canonical managed-server startup deadline', () => {
    expect(resolveOpenCodeServerLockTimeoutMsFromEnv({
      HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS: '30000',
    })).toBe(35_000);
    expect(resolveOpenCodeServerLockTimeoutMsFromEnv({
      HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS: '120000',
    })).toBe(125_000);
    expect(resolveOpenCodeServerLockTimeoutMsFromEnv({})).toBe(125_000);
  });

  it('honors explicit lock timeouts longer than the former 60 second cap', () => {
    expect(resolveOpenCodeServerLockTimeoutMsFromEnv({
      HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS: '300000',
    })).toBe(300_000);
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
