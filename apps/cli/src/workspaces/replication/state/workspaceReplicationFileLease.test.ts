import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  tryAcquireWorkspaceReplicationFileLease,
  type WorkspaceReplicationFileLeaseRecord,
} from './workspaceReplicationFileLease';

/**
 * The lease question is "is the holder **provably** gone?", and it cannot be answered by "I was
 * not allowed to look".
 *
 * `process.kill` is the OS boundary here, and it is stubbed rather than injected on purpose: the
 * failing case is the Windows `OpenProcess` denial, which libuv surfaces as **EACCES** and which
 * no POSIX test host can provoke for real. Stubbing the boundary is what lets this exercise the
 * module's real default probe instead of a hand-passed stub, so it fails again if the rule is
 * ever reverted to a local `catch`.
 */
const OWNER_PID = 424_242;

function denyProbe(code: string): void {
  const original = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid === OWNER_PID && signal === 0) {
      throw Object.assign(new Error(`kill ${code}`), { code });
    }
    return original(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
}

async function attemptToTakeLeaseFrom(ownerId: string): Promise<Readonly<{
  acquired: boolean;
  lease: WorkspaceReplicationFileLeaseRecord | null;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-replication-file-lease-'));
  const existing: WorkspaceReplicationFileLeaseRecord = {
    ownerId,
    acquiredAtMs: 0,
    renewedAtMs: 0,
    expiresAtMs: 10_000,
  };
  try {
    return await tryAcquireWorkspaceReplicationFileLease({
      leaseParentDirectory: root,
      leaseDirectory: join(root, 'lease'),
      leaseFilePath: join(root, 'lease', 'lease.json'),
      // Well inside the holder's TTL: the only thing that can authorise a takeover here is the
      // holder being gone.
      nowMs: 1_000,
      readLease: async () => existing,
      createLease: (attempt) => ({
        ownerId: 'cli-daemon:1',
        acquiredAtMs: 1_000,
        renewedAtMs: 1_000,
        expiresAtMs: 11_000,
        attempt,
      }),
    });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe('tryAcquireWorkspaceReplicationFileLease — holder liveness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses an unexpired lease whose holder we may not signal (EACCES — Windows)', async () => {
    denyProbe('EACCES');

    const result = await attemptToTakeLeaseFrom(`cli-daemon:${OWNER_PID}`);

    expect(result.acquired).toBe(false);
    expect(result.lease?.ownerId).toBe(`cli-daemon:${OWNER_PID}`);
  });

  it('refuses an unexpired lease whose holder we may not signal (EPERM — POSIX)', async () => {
    denyProbe('EPERM');

    const result = await attemptToTakeLeaseFrom(`cli-daemon:${OWNER_PID}`);

    expect(result.acquired).toBe(false);
    expect(result.lease?.ownerId).toBe(`cli-daemon:${OWNER_PID}`);
  });

  it('still takes an unexpired lease from a holder proven gone (ESRCH)', async () => {
    // The correction must not become "never steal": a crashed daemon's lease is exactly what the
    // pid probe exists to reclaim before its TTL runs out.
    denyProbe('ESRCH');

    const result = await attemptToTakeLeaseFrom(`cli-daemon:${OWNER_PID}`);

    expect(result.acquired).toBe(true);
    expect(result.lease?.ownerId).toBe('cli-daemon:1');
  });

  it('leaves an unexpired lease with an unrecognised owner id alone', async () => {
    const result = await attemptToTakeLeaseFrom('some-other-writer');

    expect(result.acquired).toBe(false);
    expect(result.lease?.ownerId).toBe('some-other-writer');
  });
});
