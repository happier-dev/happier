import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('workspaceReplicationJobLeaseHeartbeat', () => {
  it('renews the lease on an interval and stops cleanly', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-heartbeat-'));
    vi.useFakeTimers();

    try {
      const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
      const { tryAcquireWorkspaceReplicationJobLease } = await import('./workspaceReplicationJobLease');
      const { renewWorkspaceReplicationJobLease } = await import('./workspaceReplicationJobLease');
      const { startWorkspaceReplicationJobLeaseHeartbeat } = await import('./workspaceReplicationJobLeaseHeartbeat');

      let nowMs = 1000;
      await tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_heartbeat_1',
        ownerId: 'owner_a',
        nowMs,
        ttlMs: 5000,
      });

      const heartbeat = startWorkspaceReplicationJobLeaseHeartbeat({
        activeServerDir,
        jobId: 'job_lease_heartbeat_1',
        ownerId: 'owner_a',
        ttlMs: 5000,
        nowMs: () => nowMs,
      });

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const leaseFilePath = join(paths.stagingDirectory, 'job_lease_heartbeat_1', 'lease', 'lease.json');
      const initial = JSON.parse(await readFile(leaseFilePath, 'utf8')) as { acquiredAtMs: number; renewedAtMs: number };
      expect(initial.renewedAtMs).toBe(1000);

      nowMs = 2000;
      vi.advanceTimersByTime(1700);

      // Allow the async renewal write to complete.
      let renewed: { acquiredAtMs: number; renewedAtMs: number } | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        renewed = JSON.parse(await readFile(leaseFilePath, 'utf8')) as { acquiredAtMs: number; renewedAtMs: number };
        if (renewed.renewedAtMs > renewed.acquiredAtMs) break;
        await Promise.resolve();
      }

      expect(renewed?.renewedAtMs).toBeGreaterThan(renewed?.acquiredAtMs ?? Number.POSITIVE_INFINITY);

      await heartbeat.stop();
    } finally {
      vi.useRealTimers();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('marks the heartbeat as lost and clears its timer when the lease is stolen', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-heartbeat-lost-'));
    vi.useFakeTimers();

    try {
      const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
      const { tryAcquireWorkspaceReplicationJobLease, renewWorkspaceReplicationJobLease } = await import('./workspaceReplicationJobLease');
      const { startWorkspaceReplicationJobLeaseHeartbeat } = await import('./workspaceReplicationJobLeaseHeartbeat');

      let nowMs = 1000;
      await tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_heartbeat_lost_1',
        ownerId: 'owner_a',
        nowMs,
        ttlMs: 6000,
      });

      const heartbeat = startWorkspaceReplicationJobLeaseHeartbeat({
        activeServerDir,
        jobId: 'job_lease_heartbeat_lost_1',
        ownerId: 'owner_a',
        ttlMs: 6000,
        nowMs: () => nowMs,
      });

      expect(vi.getTimerCount()).toBe(1);

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const leaseFilePath = join(paths.stagingDirectory, 'job_lease_heartbeat_lost_1', 'lease', 'lease.json');

      // Simulate another runner stealing the lease (owner id changed).
      await writeFile(leaseFilePath, JSON.stringify({
        ownerId: 'owner_b',
        acquiredAtMs: 1500,
        renewedAtMs: 1500,
        expiresAtMs: 20_000,
      }), 'utf8');

      await expect(renewWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_heartbeat_lost_1',
        ownerId: 'owner_a',
        nowMs: 2000,
        ttlMs: 6000,
      })).resolves.toMatchObject({ renewed: false });

      nowMs = 2000;
      await heartbeat.probeOnce();

      expect(heartbeat.hasLeaseBeenLost()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      // stop() should remain safe/idempotent even after lease loss.
      await heartbeat.stop();
      await heartbeat.stop();
    } finally {
      vi.useRealTimers();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
