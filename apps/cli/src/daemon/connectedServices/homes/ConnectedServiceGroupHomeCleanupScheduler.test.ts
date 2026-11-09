import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { ConnectedServiceGroupHomeCleanupScheduler } from './ConnectedServiceGroupHomeCleanupScheduler';
import { resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';

describe('ConnectedServiceGroupHomeCleanupScheduler', () => {
  it('quarantines a deleted home after more than one hundred occupied quarantine names', async () => {
    const root = await createTempDir('happier-group-home-many-quarantines-');
    try {
      const identity = { serviceId: 'openai-codex' as const, groupId: 'main', agentId: 'codex' as const };
      const home = resolveConnectedServiceGroupHomeDir({ activeServerDir: root, ...identity });
      const quarantine = join(home, '..', '.quarantine');
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'session.jsonl'), 'retained-history');
      await Promise.all(Array.from({ length: 105 }, async (_, index) => {
        const occupied = join(quarantine, `123-codex${index === 0 ? '' : `-${index}`}`);
        await mkdir(occupied, { recursive: true });
        await writeFile(join(occupied, 'history'), 'previous-history');
      }));
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({ activeServerDir: root,
        hasLiveTarget: () => false, nowMs: () => 123 });
      await expect(scheduler.scheduleDeletedGroupCleanup(identity)).resolves.toMatchObject({ cleaned: true });
      expect(await readFile(join(quarantine, '123-codex-105', 'session.jsonl'), 'utf8')).toBe('retained-history');
    } finally { await removeTempDir(root); }
  });

  it('keeps a live execution Run pool home until its canonical runtime registration releases', async () => {
    const root = await createTempDir('happier-group-home-live-run-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root, serviceId: 'openai-codex', groupId: 'main', agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'run-history.jsonl'), 'private live Run history\n');
      const registry = new ConnectedServiceRuntimeRegistry();
      registry.registerRunTarget({
        runKey: 'execution_run:live', pid: 4321, agentId: 'codex', materializationKey: 'execution_run:live',
        connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'group', groupId: 'main', profileId: 'work' },
        } },
      });
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root, runtimeRegistry: registry, hasLiveTarget: () => false,
        resolveGroupDeletionAuthority: async () => ({ status: 'deleted' }),
      });
      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex', groupId: 'main', agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      expect(await readFile(join(home, 'run-history.jsonl'), 'utf8')).toBe('private live Run history\n');
      registry.unregisterRunKey('execution_run:live');
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(root);
    }
  });

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

  it('quarantines deleted durable group homes instead of recursively deleting them immediately', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-quarantine-');
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
        hasLiveTarget: () => false,
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: true, path: home });

      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      const quarantineRoot = join(root, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'main', '.quarantine');
      const entries = await readdir(quarantineRoot);
      expect(entries.some((entry) => /^\d+-codex(?:-\d+)?$/.test(entry))).toBe(true);
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

  it('reclaims a pending group home after more than three failed cleanup passes', async () => {
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
      const removePath: typeof rm = async (path, options) => {
        removeAttempts += 1;
        if (removeAttempts <= 4) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        await rm(path, options);
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
      for (let pass = 0; pass < 4; pass += 1) {
        await expect(scheduler.cleanupPendingDeletedGroupHomes()).rejects.toMatchObject({ code: 'EBUSY' });
      }

      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      expect(removeAttempts).toBe(5);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      expect(removeAttempts).toBe(5);
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
        resolveGroupDeletionAuthority: async ({ groupId }) => ({
          status: groupId === 'existing' ? 'exists' : 'deleted',
        }),
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

  it('keeps existing group homes when deletion is not positively confirmed', async () => {
    const root = await createTempDir('happier-connected-service-group-home-cleanup-unknown-');
    try {
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'gate-off',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });
      const scheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        hasLiveTarget: () => false,
      });

      await expect(scheduler.reconcileDeletedGroupHomes({
        groupExists: async () => false,
      })).resolves.toEqual([]);
      await expect(stat(home)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(root);
    }
  });
});
