import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  startSessionHandoffPrepareTargetJobLeaseHeartbeat,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from './sessionHandoffPrepareTargetJobLease';

describe('sessionHandoffPrepareTargetJobLease', () => {
  it.each(['', '.', '..', 'nested/job', 'nested\\job'])(
    'rejects non-isolated job id %j before creating a lease path',
    async (jobId) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-lease-invalid-id-'));
      try {
        await expect(tryAcquireSessionHandoffPrepareTargetJobLease({
          activeServerDir,
          jobId,
          ownerId: 'invalid-id-probe',
          nowMs: Date.now(),
          ttlMs: 5_000,
        })).rejects.toThrow('Invalid session handoff prepare-target job id');
      } finally {
        await rm(activeServerDir, { recursive: true, force: true });
      }
    },
  );

  it('preserves opaque job ids containing non-special dots', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-lease-dotted-id-'));
    try {
      const result = await tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId: 'prepare.valid_job-1',
        ownerId: 'valid-id-probe',
        nowMs: Date.now(),
        ttlMs: 5_000,
      });
      expect(result.acquired).toBe(true);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

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

  it('surfaces exact ownership replacement as lost instead of silently continuing the heartbeat', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-lease-lost-'));
    const jobId = 'prepare_test_lease_lost';
    const ownerId = 'status-probe:lost-owner';
    try {
      const acquired = await tryAcquireSessionHandoffPrepareTargetJobLease({
        activeServerDir,
        jobId,
        ownerId,
        nowMs: Date.now(),
        ttlMs: 1_000,
      });
      expect(acquired.acquired).toBe(true);
      expect(acquired.lease?.leaseId).toEqual(expect.any(String));

      const heartbeat = startSessionHandoffPrepareTargetJobLeaseHeartbeat({
        activeServerDir,
        jobId,
        ownerId,
        leaseId: acquired.lease!.leaseId!,
        ttlMs: 1_000,
        nowMs: () => Date.now(),
      });
      const leaseDirectory = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
      );
      const successor = {
        leaseId: 'successor-lease',
        attempt: 2,
        ownerId: 'real-runner:successor',
        acquiredAtMs: Date.now(),
        renewedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      };
      await writeFile(join(leaseDirectory, 'lease.json'), `${JSON.stringify(successor)}\n`, 'utf8');
      await writeFile(join(leaseDirectory, 'runner.json'), `${JSON.stringify(successor)}\n`, 'utf8');

      await vi.waitFor(() => {
        expect(heartbeat.getState()).toMatchObject({ status: 'lost' });
      }, { timeout: 5_000 });
      await expect(heartbeat.proof.validate()).resolves.toBe(false);
      await expect(heartbeat.stop()).resolves.toMatchObject({ status: 'lost' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
