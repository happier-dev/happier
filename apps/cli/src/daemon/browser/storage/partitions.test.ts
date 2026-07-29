import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createBrowserStoragePartitionOwner,
  deriveBrowserStoragePartitionId,
} from './partitions';

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('browser storage partition owner', () => {
  it('derives a deterministic, non-secret partition id from the hashed scope', () => {
    const first = deriveBrowserStoragePartitionId({
      profileId: 'profile_1',
      originKey: 'https://example.com',
      targetKind: 'localServicePreview',
    });
    const second = deriveBrowserStoragePartitionId({
      profileId: 'profile_1',
      originKey: 'https://example.com',
      targetKind: 'localServicePreview',
    });
    const different = deriveBrowserStoragePartitionId({
      profileId: 'profile_2',
      originKey: 'https://example.com',
      targetKind: 'localServicePreview',
    });

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    // Non-secret: no raw origin or profile id leaked into the id.
    expect(first).not.toContain('example.com');
    expect(first).not.toContain('profile_1');
    expect(first).toMatch(/^browser_partition_[a-f0-9]{12}$/);
  });

  it('purges on-disk partition directories bound to the given profiles and drops their in-memory records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-partitions-'));
    try {
      const owner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const partition = owner.register({
        profileId: 'profile_1',
        originKey: 'https://example.com',
        targetKind: 'localServicePreview',
        persistence: 'session',
        createdAt: 1,
        updatedAt: 1,
      });
      const partitionDir = owner.resolvePartitionDirectory(partition.partitionId);
      await mkdir(partitionDir, { recursive: true });
      await writeFile(join(partitionDir, 'cookies.db'), 'cookie-bytes');

      const result = await owner.purgePartitionsForProfiles(new Set(['profile_1']));

      expect(result.purgedPartitionIds).toEqual([partition.partitionId]);
      expect(result.failures).toEqual([]);
      expect(await pathExists(partitionDir)).toBe(false);
      expect(owner.listPartitions()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not purge partitions bound to other profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-partitions-'));
    try {
      const owner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const keep = owner.register({
        profileId: 'profile_keep',
        originKey: 'https://keep.example',
        targetKind: 'localServicePreview',
        persistence: 'session',
        createdAt: 1,
        updatedAt: 1,
      });
      const keepDir = owner.resolvePartitionDirectory(keep.partitionId);
      await mkdir(keepDir, { recursive: true });
      await writeFile(join(keepDir, 'cache'), 'keep');

      const result = await owner.purgePartitionsForProfiles(new Set(['profile_other']));

      expect(result.purgedPartitionIds).toEqual([]);
      expect(await pathExists(keepDir)).toBe(true);
      expect(owner.listPartitions().map((p) => p.partitionId)).toEqual([keep.partitionId]);
      await expect(readFile(join(keepDir, 'cache'), 'utf8')).resolves.toBe('keep');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a partition directory cannot be removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-partitions-'));
    try {
      const owner = createBrowserStoragePartitionOwner({
        storageRootDirectory: root,
        removeDirectory: async () => {
          throw new Error('EACCES');
        },
      });
      const partition = owner.register({
        profileId: 'profile_locked',
        originKey: 'https://locked.example',
        targetKind: 'localServicePreview',
        persistence: 'session',
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await owner.purgePartitionsForProfiles(new Set(['profile_locked']));

      expect(result.purgedPartitionIds).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.partitionId).toBe(partition.partitionId);
      // The partition is marked unusable, fail-closed, with a disabled reason.
      const stored = owner.listPartitions().find((p) => p.partitionId === partition.partitionId);
      expect(stored?.state).toBe('unusable');
      expect(stored?.disabledReasons?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
