import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tryAcquireSessionHandoffPrepareTargetJobLease } from './sessionHandoffPrepareTargetJobLease';

describe('sessionHandoffPrepareTargetJobLease', () => {
  it('treats stale daemon-prefixed leases as recoverable when the recorded pid is dead', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-lease-'));
    const jobId = 'prepare_test_lease_1';
    const leaseDirectory = join(
      activeServerDir,
      'session-handoff',
      'prepare-target-jobs-staging',
      jobId,
      'lease',
    );
    await mkdir(leaseDirectory, { recursive: true });

    const nowMs = Date.now();
    const staleLease = {
      leaseId: 'lease-stale',
      attempt: 1,
      ownerId: 'daemon:999999:stale',
      acquiredAtMs: nowMs - 500,
      renewedAtMs: nowMs - 250,
      expiresAtMs: nowMs + 60_000,
    };

    await writeFile(join(leaseDirectory, 'lease.json'), `${JSON.stringify(staleLease)}\n`, 'utf8');
    await writeFile(join(leaseDirectory, 'runner.json'), `${JSON.stringify(staleLease)}\n`, 'utf8');

    const attempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
      activeServerDir,
      jobId,
      ownerId: `cli-daemon:${process.pid}:new`,
      nowMs,
      ttlMs: 5_000,
    });

    expect(attempt.acquired).toBe(true);
    expect(attempt.lease?.ownerId).toMatch(/^cli-daemon:/u);
  });
});
