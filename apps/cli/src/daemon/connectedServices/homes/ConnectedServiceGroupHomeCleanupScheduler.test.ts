import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { ConnectedServiceGroupHomeCleanupScheduler } from './ConnectedServiceGroupHomeCleanupScheduler';
import { resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';

describe('ConnectedServiceGroupHomeCleanupScheduler', () => {
  it('removes a deleted group home only after no live target references it', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => true,
      });

      await scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await expect(stat(home)).resolves.toBeTruthy();

      const readyScheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => false,
      });
      await readyScheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(home).toBe(join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'main', 'codex'));
    } finally {
      await removeTempDir(root);
    }
  });

  it('remembers deleted group homes and removes them when live targets disappear later', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-deferred-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      let live = true;
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => live,
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      await expect(stat(home)).resolves.toBeTruthy();

      live = false;
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
    } finally {
      await removeTempDir(root);
    }
  });

  it('does not delete a pending group home when the group was recreated with the same id', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-recreated-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      let live = true;
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => live,
        groupExists: async ({ groupId }) => groupId === 'main',
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });

      live = false;
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      await expect(stat(home)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(root);
    }
  });

  it('keeps a failed pending cleanup retryable instead of dropping the target', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-retry-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      let live = true;
      let removeAttempts = 0;
      const removePath: typeof rm = async () => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      };
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => live,
        removePath,
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });

      live = false;
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).rejects.toMatchObject({ code: 'EBUSY' });
      expect(removeAttempts).toBe(1);

      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      expect(removeAttempts).toBe(2);
    } finally {
      await removeTempDir(root);
    }
  });

  it('reconciles existing group homes whose server group is gone without deleting live targets', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-reconcile-');
    try {
      const deletedHome = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'deleted',
        agentId: 'codex',
      });
      const liveDeletedHome = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'live-deleted',
        agentId: 'codex',
      });
      const existingHome = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'existing',
        agentId: 'codex',
      });
      await mkdir(deletedHome, { recursive: true });
      await mkdir(liveDeletedHome, { recursive: true });
      await mkdir(existingHome, { recursive: true });

      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: ({ groupId }) => groupId === 'live-deleted',
      });

      await expect(scheduler.reconcileDeletedGroupHomes({
        groupExists: async ({ groupId }) => groupId === 'existing',
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ cleaned: true, path: deletedHome }),
        expect.objectContaining({ cleaned: false, pending: true, path: liveDeletedHome }),
      ]));
      await expect(stat(deletedHome)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(liveDeletedHome)).resolves.toBeTruthy();
      await expect(stat(existingHome)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(root);
    }
  });
});
