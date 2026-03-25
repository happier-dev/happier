import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('workspaceReplicationScopeLease', () => {
  it('acquires a scope lease and fails closed while unexpired', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-scope-lease-'));

    try {
      const { tryAcquireWorkspaceReplicationScopeLease } = await import('./workspaceReplicationScopeLease');

      const acquired = await tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: 'rel_test',
        directionId: 'dir_test',
        ownerId: 'owner_1',
        nowMs: 10,
        ttlMs: 1_000,
      });
      expect(acquired.acquired).toBe(true);
      expect(acquired.lease?.ownerId).toBe('owner_1');
      expect(acquired.lease?.attempt).toBe(1);

      const blocked = await tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: 'rel_test',
        directionId: 'dir_test',
        ownerId: 'owner_2',
        nowMs: 11,
        ttlMs: 1_000,
      });
      expect(blocked.acquired).toBe(false);
      expect(blocked.lease?.ownerId).toBe('owner_1');
      expect(blocked.lease?.expiresAtMs).toBeGreaterThan(11);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('allows stealing an expired scope lease and increments attempt', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-scope-lease-expiry-'));

    try {
      const { tryAcquireWorkspaceReplicationScopeLease } = await import('./workspaceReplicationScopeLease');

      await tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: 'rel_test',
        directionId: 'dir_test',
        ownerId: 'owner_1',
        nowMs: 10,
        ttlMs: 5,
      });

      const acquired = await tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: 'rel_test',
        directionId: 'dir_test',
        ownerId: 'owner_2',
        nowMs: 20,
        ttlMs: 5,
      });

      expect(acquired.acquired).toBe(true);
      expect(acquired.lease?.ownerId).toBe('owner_2');
      expect(acquired.lease?.attempt).toBe(2);
      expect(acquired.lease?.expiresAtMs).toBe(25);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('steals an unexpired scope lease when the lease owner pid is no longer alive', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-scope-lease-dead-pid-'));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 424242) {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true as never;
    }) as typeof process.kill);

    try {
      const { tryAcquireWorkspaceReplicationScopeLease } = await import('./workspaceReplicationScopeLease');

      await expect(tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: 'rel_test',
        directionId: 'dir_test',
        ownerId: 'cli-daemon:424242',
        nowMs: 10,
        ttlMs: 1_000,
      })).resolves.toMatchObject({
        acquired: true,
        lease: expect.objectContaining({ ownerId: 'cli-daemon:424242', attempt: 1, expiresAtMs: 1010 }),
      });

      await expect(tryAcquireWorkspaceReplicationScopeLease({
        activeServerDir,
        relationshipId: 'rel_test',
        directionId: 'dir_test',
        ownerId: 'owner_2',
        nowMs: 11,
        ttlMs: 1_000,
      })).resolves.toMatchObject({
        acquired: true,
        lease: expect.objectContaining({ ownerId: 'owner_2', attempt: 2, acquiredAtMs: 11, renewedAtMs: 11, expiresAtMs: 1011 }),
      });
    } finally {
      killSpy.mockRestore();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
