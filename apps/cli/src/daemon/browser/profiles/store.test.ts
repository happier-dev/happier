import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserProfileStore } from './store';

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('browser profile store disk purge', () => {
  it('purges session-mode profiles and their bound partitions on session delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const auditRecords: unknown[] = [];
      const store = createBrowserProfileStore({
        storageRootDirectory: root,
        partitionOwner,
        emitAudit: (record) => auditRecords.push(record),
      });

      store.register({
        profileId: 'profile_session',
        storageMode: 'session',
        owner: { kind: 'session', id: 'session_1' },
      });
      const partition = partitionOwner.register({
        profileId: 'profile_session',
        originKey: 'https://example.com',
        targetKind: 'localServicePreview',
        persistence: 'session',
        createdAt: 1,
        updatedAt: 1,
      });
      const profileDir = store.resolveProfileDirectory('profile_session');
      const partitionDir = partitionOwner.resolvePartitionDirectory(partition.partitionId);
      await mkdir(profileDir, { recursive: true });
      await mkdir(partitionDir, { recursive: true });
      await writeFile(join(profileDir, 'state'), 'x');
      await writeFile(join(partitionDir, 'cookies.db'), 'y');

      const result = await store.purgeForSessionDeleted({ sessionId: 'session_1' });

      expect(result.purgedProfileIds).toEqual(['profile_session']);
      expect(result.failedProfileIds).toEqual([]);
      expect(await pathExists(profileDir)).toBe(false);
      expect(await pathExists(partitionDir)).toBe(false);
      expect(store.getProfile('profile_session')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not purge session-mode profiles for a different session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const store = createBrowserProfileStore({ storageRootDirectory: root, partitionOwner });
      store.register({
        profileId: 'profile_other',
        storageMode: 'session',
        owner: { kind: 'session', id: 'session_other' },
      });

      const result = await store.purgeForSessionDeleted({ sessionId: 'session_target' });

      expect(result.purgedProfileIds).toEqual([]);
      expect(store.getProfile('profile_other')?.lifecycleState).not.toBe('unusable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('purges ephemeral profiles and their partitions on logout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const store = createBrowserProfileStore({ storageRootDirectory: root, partitionOwner });
      store.register({
        profileId: 'profile_ephemeral',
        storageMode: 'ephemeral',
        owner: { kind: 'session', id: 'session_a' },
      });
      store.register({
        profileId: 'profile_user',
        storageMode: 'user',
        owner: { kind: 'user', id: 'user_1' },
      });
      const partition = partitionOwner.register({
        profileId: 'profile_ephemeral',
        originKey: 'https://eph.example',
        targetKind: 'localServicePreview',
        persistence: 'ephemeral',
        createdAt: 1,
        updatedAt: 1,
      });
      const partitionDir = partitionOwner.resolvePartitionDirectory(partition.partitionId);
      await mkdir(partitionDir, { recursive: true });
      await writeFile(join(partitionDir, 'idb'), 'z');

      const result = await store.purgeForLogout();

      expect(result.purgedProfileIds).toEqual(['profile_ephemeral']);
      expect(await pathExists(partitionDir)).toBe(false);
      expect(store.getProfile('profile_ephemeral')).toBeNull();
      // User profiles survive logout.
      expect(store.getProfile('profile_user')?.lifecycleState).not.toBe('unusable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the profile directory cannot be removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const auditRecords: Array<{ kind: string; profileId: string }> = [];
      const store = createBrowserProfileStore({
        storageRootDirectory: root,
        partitionOwner,
        removeDirectory: async () => {
          throw new Error('EACCES');
        },
        emitAudit: (record) => auditRecords.push(record),
        now: () => 5_000,
      });
      store.register({
        profileId: 'profile_locked',
        storageMode: 'session',
        owner: { kind: 'session', id: 'session_locked' },
      });

      const result = await store.purgeForSessionDeleted({ sessionId: 'session_locked' });

      expect(result.purgedProfileIds).toEqual([]);
      expect(result.failedProfileIds).toEqual(['profile_locked']);
      const profile = store.getProfile('profile_locked');
      expect(profile?.lifecycleState).toBe('unusable');
      expect(profile?.purgeFailure?.reasonCode).toBe('disk_purge_failed');
      expect((profile?.disabledReasons?.length ?? 0)).toBeGreaterThan(0);
      // The profile is no longer usable for new partitions: a fail-closed audit was emitted.
      expect(auditRecords.some((r) => r.kind === 'browser_profile_purge_failed' && r.profileId === 'profile_locked')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks the profile unusable when a bound partition purge fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({
        storageRootDirectory: root,
        removeDirectory: async () => {
          throw new Error('partition EACCES');
        },
      });
      const store = createBrowserProfileStore({
        storageRootDirectory: root,
        partitionOwner,
        removeDirectory: vi.fn(async () => {}),
      });
      store.register({
        profileId: 'profile_partition_fail',
        storageMode: 'session',
        owner: { kind: 'session', id: 'session_pf' },
      });
      partitionOwner.register({
        profileId: 'profile_partition_fail',
        originKey: 'https://pf.example',
        targetKind: 'localServicePreview',
        persistence: 'session',
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await store.purgeForSessionDeleted({ sessionId: 'session_pf' });

      expect(result.failedProfileIds).toEqual(['profile_partition_fail']);
      expect(store.getProfile('profile_partition_fail')?.lifecycleState).toBe('unusable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
