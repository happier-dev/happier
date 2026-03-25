import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('workspaceReplicationScopeLeaseHeartbeat', () => {
  it('marks the heartbeat as lost and clears its timer when the lease is stolen', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-scope-lease-heartbeat-lost-'));
    vi.useFakeTimers();

    try {
      const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');
      const { tryAcquireWorkspaceReplicationScopeLease } = await import('./workspaceReplicationScopeLease');
      const { startWorkspaceReplicationScopeLeaseHeartbeat } = await import('./workspaceReplicationScopeLeaseHeartbeat');

      let nowMs = 1000;
      await tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: 'rel_scope_heartbeat_1',
        directionId: 'dir_scope_heartbeat_1',
        ownerId: 'owner_a',
        nowMs,
        ttlMs: 6000,
      });

      const heartbeat = startWorkspaceReplicationScopeLeaseHeartbeat({
        activeServerDir,
        relationshipId: 'rel_scope_heartbeat_1',
        directionId: 'dir_scope_heartbeat_1',
        ownerId: 'owner_a',
        ttlMs: 6000,
        nowMs: () => nowMs,
      });

      expect(vi.getTimerCount()).toBe(1);

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const leaseFilePath = join(
        paths.rootDirectory,
        'scope-leases',
        'rel_scope_heartbeat_1__dir_scope_heartbeat_1',
        'lease',
        'lease.json',
      );

      await writeFile(leaseFilePath, JSON.stringify({
        ownerId: 'owner_b',
        acquiredAtMs: 1500,
        renewedAtMs: 1500,
        expiresAtMs: 20_000,
      }), 'utf8');

      nowMs = 2000;
      await heartbeat.probeOnce();

      expect(heartbeat.hasLeaseBeenLost()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      await heartbeat.stop();
      await heartbeat.stop();
    } finally {
      vi.useRealTimers();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});

