import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('workspaceReplicationJobLease', () => {
  it('acquires a lease when none exists', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-'));
    try {
      const { tryAcquireWorkspaceReplicationJobLease } = await import('./workspaceReplicationJobLease');
      const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');

      const nowMs = 1000;
      const result = await tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_1',
        ownerId: 'owner_a',
        nowMs,
        ttlMs: 10_000,
      });

      expect(result).toMatchObject({
        acquired: true,
        lease: {
          leaseId: expect.any(String),
          attempt: 1,
          ownerId: 'owner_a',
          acquiredAtMs: nowMs,
          renewedAtMs: nowMs,
          expiresAtMs: nowMs + 10_000,
        },
      });

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const leaseFilePath = join(paths.stagingDirectory, 'job_lease_1', 'lease', 'lease.json');
      const persisted = JSON.parse(await readFile(leaseFilePath, 'utf8')) as { ownerId: string; leaseId?: string; attempt?: number };
      expect(persisted.ownerId).toBe('owner_a');
      expect(typeof persisted.leaseId).toBe('string');
      expect(persisted.attempt).toBe(1);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when an unexpired lease exists', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-existing-'));
    try {
      const { tryAcquireWorkspaceReplicationJobLease } = await import('./workspaceReplicationJobLease');

      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_2',
        ownerId: 'owner_a',
        nowMs: 1000,
        ttlMs: 10_000,
      })).resolves.toMatchObject({
        acquired: true,
        lease: { ownerId: 'owner_a', attempt: 1 },
      });

      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_2',
        ownerId: 'owner_b',
        nowMs: 2000,
        ttlMs: 10_000,
      })).resolves.toEqual({
        acquired: false,
        lease: expect.objectContaining({
          ownerId: 'owner_a',
          attempt: 1,
          acquiredAtMs: 1000,
          renewedAtMs: 1000,
          expiresAtMs: 11_000,
        }),
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('steals an expired lease and reacquires', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-expired-'));
    try {
      const { tryAcquireWorkspaceReplicationJobLease } = await import('./workspaceReplicationJobLease');

      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_3',
        ownerId: 'owner_a',
        nowMs: 1000,
        ttlMs: 10,
      })).resolves.toMatchObject({
        acquired: true,
        lease: { ownerId: 'owner_a', attempt: 1, expiresAtMs: 1010 },
      });

      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_3',
        ownerId: 'owner_b',
        nowMs: 5000,
        ttlMs: 10_000,
      })).resolves.toEqual({
        acquired: true,
        lease: expect.objectContaining({
          ownerId: 'owner_b',
          attempt: 2,
          acquiredAtMs: 5000,
          renewedAtMs: 5000,
          expiresAtMs: 15_000,
        }),
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('steals an unexpired lease when the lease owner pid is no longer alive', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-dead-pid-'));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 424242) {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true as never;
    }) as typeof process.kill);

    try {
      const { tryAcquireWorkspaceReplicationJobLease } = await import('./workspaceReplicationJobLease');

      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_dead_pid_1',
        ownerId: 'cli-daemon:424242',
        nowMs: 1000,
        ttlMs: 10_000,
      })).resolves.toMatchObject({
        acquired: true,
        lease: expect.objectContaining({
          ownerId: 'cli-daemon:424242',
          attempt: 1,
          expiresAtMs: 11_000,
        }),
      });

      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_dead_pid_1',
        ownerId: 'owner_b',
        nowMs: 2000,
        ttlMs: 10_000,
      })).resolves.toMatchObject({
        acquired: true,
        lease: expect.objectContaining({
          ownerId: 'owner_b',
          attempt: 2,
          acquiredAtMs: 2000,
          renewedAtMs: 2000,
          expiresAtMs: 12_000,
        }),
      });
    } finally {
      killSpy.mockRestore();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('renews the lease when owned by the caller', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-renew-'));
    try {
      const { tryAcquireWorkspaceReplicationJobLease, renewWorkspaceReplicationJobLease } = await import(
        './workspaceReplicationJobLease'
      );

      const acquired = await tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_renew_1',
        ownerId: 'owner_a',
        nowMs: 1000,
        ttlMs: 10_000,
      });
      expect(acquired.acquired).toBe(true);
      expect(acquired.lease?.attempt).toBe(1);

      const renewed = await renewWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_renew_1',
        ownerId: 'owner_a',
        nowMs: 2000,
        ttlMs: 10_000,
      });

      expect(renewed).toMatchObject({
        renewed: true,
        lease: {
          ownerId: 'owner_a',
          acquiredAtMs: 1000,
          renewedAtMs: 2000,
          expiresAtMs: 12_000,
          attempt: 1,
        },
      });
      expect(typeof renewed.lease?.leaseId).toBe('string');
      expect(renewed.lease?.leaseId).toBe(acquired.lease?.leaseId);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when renewing an expired lease (zombie runner cannot extend after TTL)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-renew-expired-'));
    try {
      const { tryAcquireWorkspaceReplicationJobLease, renewWorkspaceReplicationJobLease } = await import(
        './workspaceReplicationJobLease'
      );

      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_renew_expired_1',
        ownerId: 'owner_a',
        nowMs: 1000,
        ttlMs: 10,
      })).resolves.toMatchObject({
        acquired: true,
        lease: expect.objectContaining({
          ownerId: 'owner_a',
          expiresAtMs: 1010,
        }),
      });

      await expect(renewWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_renew_expired_1',
        ownerId: 'owner_a',
        nowMs: 2000,
        ttlMs: 10_000,
      })).resolves.toMatchObject({
        renewed: false,
        lease: expect.objectContaining({
          ownerId: 'owner_a',
          acquiredAtMs: 1000,
          renewedAtMs: 1000,
          expiresAtMs: 1010,
        }),
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when renewing a lease owned by another runner', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-renew-mismatch-'));
    try {
      const { tryAcquireWorkspaceReplicationJobLease, renewWorkspaceReplicationJobLease } = await import(
        './workspaceReplicationJobLease'
      );

      await expect(tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_renew_2',
        ownerId: 'owner_a',
        nowMs: 1000,
        ttlMs: 10_000,
      })).resolves.toMatchObject({ acquired: true, lease: { ownerId: 'owner_a', attempt: 1 } });

      await expect(renewWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_renew_2',
        ownerId: 'owner_b',
        nowMs: 2000,
        ttlMs: 10_000,
      })).resolves.toMatchObject({
        renewed: false,
        lease: {
          ownerId: 'owner_a',
          acquiredAtMs: 1000,
          renewedAtMs: 1000,
          expiresAtMs: 11_000,
          attempt: 1,
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('releases the lease when owned by the caller', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-release-'));
    try {
      const { tryAcquireWorkspaceReplicationJobLease, releaseWorkspaceReplicationJobLease } = await import(
        './workspaceReplicationJobLease'
      );
      const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');

      await tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_4',
        ownerId: 'owner_a',
        nowMs: 1000,
        ttlMs: 10_000,
      });

      await releaseWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_4',
        ownerId: 'owner_a',
      });

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      const leaseDir = join(paths.stagingDirectory, 'job_lease_4', 'lease');
      await expect(readFile(join(leaseDir, 'lease.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('removes the entire job staging directory', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-replication-lease-clean-'));
    try {
      const { tryAcquireWorkspaceReplicationJobLease, removeWorkspaceReplicationJobStagingDirectory } = await import(
        './workspaceReplicationJobLease'
      );
      const { createWorkspaceReplicationPaths } = await import('./workspaceReplicationPaths');

      await tryAcquireWorkspaceReplicationJobLease({
        activeServerDir,
        jobId: 'job_lease_5',
        ownerId: 'owner_a',
        nowMs: 1000,
        ttlMs: 10_000,
      });
      await removeWorkspaceReplicationJobStagingDirectory({
        activeServerDir,
        jobId: 'job_lease_5',
      });

      const paths = createWorkspaceReplicationPaths({ activeServerDir });
      await expect(readFile(join(paths.stagingDirectory, 'job_lease_5', 'lease', 'lease.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
