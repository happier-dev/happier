import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  }), 'utf8');

  let ranEffect = false;
  try {
    await withJsonOwnerFileLock(
      {
        lockPath,
        timeoutMs: 300,
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
});
