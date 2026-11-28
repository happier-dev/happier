import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, mkdtemp, open, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProcessStartTimeMsSync } from '@happier-dev/cli-common/processInstance';

import { reclaimJsonOwnerFileLockSnapshot, withJsonOwnerFileLock } from './jsonOwnerFileLock.js';

/**
 * A lock may only be reclaimed from a holder **proven** gone.
 *
 * This lock's staleness rule used to be `code === 'EPERM'`, which reads the Windows `OpenProcess`
 * denial — surfaced by libuv as **EACCES** — as a dead owner, and reclaims a lock a live process is
 * still holding. `process.kill` is stubbed rather than injected because EACCES cannot be provoked
 * for real on a POSIX test host, and because stubbing the boundary is what makes this exercise the
 * module's real default probe.
 */
const OWNER_PID = 424_242;

function probeThrows(code: string): void {
  const original = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid === OWNER_PID && signal === 0) {
      throw Object.assign(new Error(`kill ${code}`), { code });
    }
    return original(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
}

async function raceForLockHeldBy(pid: number): Promise<Readonly<{ ranEffect: boolean; error: unknown }>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-liveness-'));
  const lockPath = join(root, 'store.lock');
  const heldAtMs = Date.now() - 60_000;
  await writeFile(lockPath, JSON.stringify({
    pid,
    ownerToken: randomUUID(),
    processStartedAtMs: heldAtMs,
    createdAtMs: heldAtMs,
    updatedAtMs: heldAtMs,
    retired: true,
  }), 'utf8');

  let ranEffect = false;
  try {
    await withJsonOwnerFileLock(
      {
        lockPath,
        // This test exercises the liveness decision, not sub-second filesystem
        // latency. Durable lock publication exceeded 300ms under the full source
        // lane while the same ESRCH path remained correct in focused runs.
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        // Deliberately tiny: the mtime fallback must not be what decides this. A parsed owner
        // record is judged by its pid, so only the liveness rule can authorise a reclaim.
        staleAfterMs: 1,
        errorCode: 'json_owner_lock_timeout',
      },
      async () => {
        ranEffect = true;
      },
    );
    return { ranEffect, error: null };
  } catch (error) {
    return { ranEffect, error };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe('withJsonOwnerFileLock — holder liveness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not reclaim a lock whose holder we may not signal (EACCES — Windows)', async () => {
    probeThrows('EACCES');

    const { ranEffect, error } = await raceForLockHeldBy(OWNER_PID);

    expect(ranEffect).toBe(false);
    expect((error as Error | null)?.message).toBe('json_owner_lock_timeout');
  });

  it('does not reclaim a lock whose holder we may not signal (EPERM — POSIX)', async () => {
    probeThrows('EPERM');

    const { ranEffect, error } = await raceForLockHeldBy(OWNER_PID);

    expect(ranEffect).toBe(false);
    expect((error as Error | null)?.message).toBe('json_owner_lock_timeout');
  });

  it('still reclaims a lock whose holder is proven gone (ESRCH)', async () => {
    // The correction must not become "never reclaim": a crashed holder's lock is exactly what the
    // staleness rule exists to recover.
    probeThrows('ESRCH');

    const { ranEffect, error } = await raceForLockHeldBy(OWNER_PID);

    expect(error).toBeNull();
    expect(ranEffect).toBe(true);
  });

  it('records the same process-start witness that contenders read for PID reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-witness-'));
    const lockPath = join(root, 'store.lock');
    try {
      await withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 300,
        staleAfterMs: 1,
        errorCode: 'json_owner_lock_timeout',
        readProcessStartedAtMs: async () => 123_450,
      }, async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
        expect(owner.processStartedAtMs).toBe(123_450);
        // The shipping 0.2 reader accepts exactly these keys and treats
        // ownerToken as opaque; it must be able to recognize a live holder.
        expect(Object.keys(owner).sort()).toEqual([
          'createdAtMs', 'ownerToken', 'pid', 'processStartedAtMs', 'updatedAtMs',
        ]);
        expect(owner.ownerToken).toMatch(/^observed:/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes an observed witness even when the caller omits the process reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-default-witness-'));
    const lockPath = join(root, 'store.lock');
    try {
      await withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 300,
        staleAfterMs: 1,
        errorCode: 'json_owner_lock_timeout',
      }, async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
        expect(owner.processStartedAtMs).toBe(readProcessStartTimeMsSync(process.pid));
        expect(owner.ownerToken).toMatch(/^observed:/u);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not reclaim a live legacy wall-clock owner using a boot-relative observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-legacy-'));
    const lockPath = join(root, 'store.lock');
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });
    if (!holder.pid) throw new Error('Could not start lock-holder witness');
    const raw = JSON.stringify({
      pid: holder.pid,
      ownerToken: randomUUID(),
      processStartedAtMs: Date.now() - 60_000,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    try {
      await writeFile(lockPath, raw, 'utf8');
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 100,
        staleAfterMs: 1,
        errorCode: 'json_owner_lock_timeout',
        readProcessStartedAtMs: async () => 123_450,
      }, async () => 'stolen')).rejects.toThrow('json_owner_lock_timeout');
      expect(await readFile(lockPath, 'utf8')).toBe(raw);
    } finally {
      holder.kill();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reclaims a live PID only when a tagged numeric witness proves reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-json-owner-lock-reuse-'));
    const lockPath = join(root, 'store.lock');
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });
    if (!holder.pid) throw new Error('Could not start lock-holder witness');
    try {
      await writeFile(lockPath, JSON.stringify({
        pid: holder.pid,
        ownerToken: `observed:${randomUUID()}`,
        processStartedAtMs: 123_450,
        createdAtMs: 1,
        updatedAtMs: 1,
      }), 'utf8');
      await expect(withJsonOwnerFileLock({
        lockPath,
        timeoutMs: 300,
        staleAfterMs: 1,
        errorCode: 'json_owner_lock_timeout',
        readProcessStartedAtMs: async (pid) => pid === holder.pid ? 123_460 : 123_450,
      }, async () => 'reclaimed')).resolves.toBe('reclaimed');
    } finally {
      holder.kill();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('withJsonOwnerFileLock — crash recovery without per-lock fsync', () => {
  afterEach(() => vi.restoreAllMocks());

  async function inRoot<T>(name: string, run: (lockPath: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), `happier-json-owner-lock-${name}-`));
    try { return await run(join(root, 'store.lock')); } finally { await rm(root, { recursive: true, force: true }); }
  }

  it('retires its published reclaim guard after a hard-link metadata change', async () => {
    await inRoot('guard-link-metadata', async (lockPath) => {
      const guardPath = `${lockPath}.reclaim`;
      const guardAlias = `${guardPath}.alias`;
      const retiredOwner = 'retired lock owner';
      await writeFile(lockPath, retiredOwner, 'utf8');

      await expect(reclaimJsonOwnerFileLockSnapshot(lockPath, retiredOwner, async (quarantinePath) => {
        const before = await stat(guardPath);
        await delay(20);
        await link(guardPath, guardAlias);
        await unlink(guardAlias);
        const after = await stat(guardPath);
        expect(after.ctimeMs).not.toBe(before.ctimeMs);
        return await readFile(quarantinePath, 'utf8');
      })).resolves.toBe('reclaimed');

      await expect(readdir(dirname(lockPath))).resolves.toEqual([]);
      await expect(withJsonOwnerFileLock({
        lockPath, timeoutMs: 1_000, errorCode: 'json_owner_lock_timeout',
      }, async () => 'acquired')).resolves.toBe('acquired');
    });
  });

  it('publishes and releases ownership without flushing the owner or guard bytes to disk', async () => {
    await inRoot('nosync', async (lockPath) => {
      const probe = await open(`${lockPath}.probe`, 'w');
      const sync = vi.spyOn(Object.getPrototypeOf(probe), 'sync');
      await probe.close();
      await withJsonOwnerFileLock({ lockPath, timeoutMs: 1_000, errorCode: 'json_owner_lock_timeout' }, async () => undefined);
      // The owner record only has to survive its process, which the page cache does. A lost
      // record after power loss is recovered by the boot rule below, not by an fsync per lock.
      expect(sync).toHaveBeenCalledTimes(0);
    });
  });

  it('reclaims unreadable owner bytes left before this boot, with no age threshold', async () => {
    await inRoot('preboot', async (lockPath) => {
      await writeFile(lockPath, '', 'utf8');
      const beforeBoot = (Date.now() - uptime() * 1_000 - 60_000) / 1_000;
      await utimes(lockPath, beforeBoot, beforeBoot);
      await expect(withJsonOwnerFileLock({ lockPath, timeoutMs: 300, errorCode: 'json_owner_lock_timeout' },
        async () => 'reclaimed')).resolves.toBe('reclaimed');
    });
  });

  it('preserves unreadable owner bytes written during this boot', async () => {
    await inRoot('thisboot', async (lockPath) => {
      await writeFile(lockPath, '', 'utf8');
      await expect(withJsonOwnerFileLock({ lockPath, timeoutMs: 100, errorCode: 'json_owner_lock_timeout' },
        async () => 'stolen')).rejects.toThrow('json_owner_lock_timeout');
      expect(await readFile(lockPath, 'utf8')).toBe('');
    });
  });
});
