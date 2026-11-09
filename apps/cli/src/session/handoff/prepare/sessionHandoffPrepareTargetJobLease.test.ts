import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as processRunState from '@/daemon/processRunState';
import * as processIdentity from '@/daemon/processIdentity';

import { releaseSessionHandoffPrepareTargetJobLease, tryAcquireSessionHandoffPrepareTargetJobLease } from './sessionHandoffPrepareTargetJobLease';

describe('sessionHandoffPrepareTargetJobLease', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['live', 'unknown', 'dead', 'reused'] as const)('uses physical process evidence for an expired %s holder', async state => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-physical-lease-'));
    const leaseDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs-staging', 'job', 'lease');
    const self = await processIdentity.readProcessIdentityByPid(process.pid);
    if (self?.processStartTimeMs === undefined) throw new Error('Current process birth unavailable');
    try {
      await mkdir(leaseDirectory, { recursive: true });
      await writeFile(join(leaseDirectory, 'lease.json'), JSON.stringify({
        leaseId: 'incumbent', attempt: 1, ownerId: `daemon:${process.pid}:incumbent`,
        ownerProcess: { pid: process.pid, processStartTimeMs: self.processStartTimeMs + (state === 'reused' ? 120_000 : 0) },
        acquiredAtMs: 1, renewedAtMs: 1, expiresAtMs: 2,
      }));
      // Process run-state is the OS boundary. All claim parsing, admission and
      // process-generation comparison below it remain real.
      vi.spyOn(processRunState, 'readProcessRunState').mockResolvedValue(state === 'dead' ? 'dead' : state === 'unknown' ? 'unknown' : 'servable');
      const next = await tryAcquireSessionHandoffPrepareTargetJobLease({ activeServerDir, jobId: 'job', ownerId: 'successor', nowMs: 120_001 });
      expect(next.acquired).toBe(state === 'dead' || state === 'reused');
      if (!next.acquired) expect(next.lease?.leaseId).toBe('incumbent');
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });

  it('does not release a later claim held by the same owner', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'handoff-exact-lease-'));
    const input = { activeServerDir, jobId: 'job', ownerId: 'same-owner' };
    try {
      const first = await tryAcquireSessionHandoffPrepareTargetJobLease({ ...input, nowMs: 1 });
      if (!first.acquired || !first.lease?.leaseId) throw new Error('First claim unavailable');
      const releaseFirst = { ...input, leaseId: first.lease.leaseId };
      await releaseSessionHandoffPrepareTargetJobLease(releaseFirst);
      const successor = await tryAcquireSessionHandoffPrepareTargetJobLease({ ...input, nowMs: 2 });
      if (!successor.acquired) throw new Error('Successor claim unavailable');
      await releaseSessionHandoffPrepareTargetJobLease(releaseFirst);
      const contender = await tryAcquireSessionHandoffPrepareTargetJobLease({ ...input, ownerId: 'contender', nowMs: 3 });
      expect(contender.acquired).toBe(false);
      expect(contender.lease?.leaseId).toBe(successor.lease?.leaseId);
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
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
    });

    expect(attempt.acquired).toBe(true);
    expect(attempt.lease?.ownerId).toMatch(/^cli-daemon:/u);
    await rm(activeServerDir, { recursive: true, force: true });
  });
});
