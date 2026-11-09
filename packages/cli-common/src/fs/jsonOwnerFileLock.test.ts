import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProcessStartTimeMsSync } from '@happier-dev/cli-common/processInstance';

import { withJsonOwnerFileLock } from './jsonOwnerFileLock.js';

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
