import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveRequesterSessionRuntimeDirectories } from '../../sessionEncryption/requesterSessionRuntimeDirectories';
import type { TrackedSession } from '../../types';
import { createConnectedServiceGroupHomeCleanupScheduler } from './createConnectedServiceGroupHomeCleanupScheduler';
import { resolveConnectedServiceGroupHomeDir, resolveConnectedServiceHomeDir } from './resolveConnectedServiceHomeDir';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// Only filesystem rename is faulted; tracked binding parsing, factory wiring,
// group-home selection and eventual quarantine use their real owners.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
});
afterAll(async () => { await runtime?.dispose(); });

async function writeRetainedAccountHome(home: string) {
  await mkdir(join(home, 'codex-home'), { recursive: true });
  await writeFile(join(home, 'codex-home', 'auth.json'), 'fake-selected-credential');
  await writeFile(join(home, 'codex-home', 'retained-history'), 'isolated-session-history');
}

describe('createConnectedServiceGroupHomeCleanupScheduler', () => {
  it('removes ordinary and admitted same-Account homes after the selected Session releases them', async () => {
    const root = await createTempDir('happier-connected-service-account-scoped-home-');
    try {
      const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
      const requesterRoot = (accountId: string) => resolveRequesterSessionRuntimeDirectories({
        activeServerDir: root, connectedServicesMaterializationBaseDir: root, attribution: { accountId },
      }).activeServerDir;
      const homeAt = (activeServerDir: string) => resolveConnectedServiceHomeDir({
        activeServerDir, serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', agentId: 'codex',
      });
      const ownRoots = [root, requesterRoot('owner')];
      const ownHomes = ownRoots.map(homeAt);
      const foreignHome = homeAt(requesterRoot('other-account'));
      await Promise.all([...ownHomes, foreignHome].map(writeRetainedAccountHome));
      const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[legacyPidSessionTrackingKey(123), {
        trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon', happySessionId: 'session-1', pid: 123,
        spawnOptions: { directory: '/tmp/project', connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        } } },
      }]]);
      const scheduler = createConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root, additionalAccountHomeRoots: [ownRoots[1]!], trackedSessionsByKey,
      });
      await expect(scheduler.scheduleDeletedAccountCleanup({ account })).resolves.toMatchObject({ cleaned: false, pending: true });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      for (const home of ownHomes) await expect(stat(home)).resolves.toBeTruthy();
      trackedSessionsByKey.clear();
      await scheduler.cleanupPendingDeletedGroupHomes();
      for (const home of ownHomes) {
        await expect(stat(join(home, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(home, 'codex-home', 'retained-history'), 'utf8')).toBe('isolated-session-history');
      }
      expect(await readFile(join(foreignHome, 'codex-home', 'auth.json'), 'utf8')).toBe('fake-selected-credential');
    } finally { await removeTempDir(root); }
  });

  it('retains a revoked account home until its tracked Session exits', async () => {
    const root = await createTempDir('happier-connected-service-account-home-live-target-');
    try {
      const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
      const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([[legacyPidSessionTrackingKey(123), {
        trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon', happySessionId: 'session-1', pid: 123,
        spawnOptions: { directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
          } } },
      }]]);
      const home = resolveConnectedServiceHomeDir({ activeServerDir: root, serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', agentId: 'codex' });
      await writeRetainedAccountHome(home);
      const scheduler = createConnectedServiceGroupHomeCleanupScheduler({ activeServerDir: root, trackedSessionsByKey });
      await expect(scheduler.scheduleDeletedAccountCleanup({ account })).resolves.toMatchObject({ cleaned: false, pending: true });
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([]);
      await expect(stat(home)).resolves.toBeTruthy();
      trackedSessionsByKey.clear();
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([expect.objectContaining({ cleaned: true })]);
      await expect(stat(join(home, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(home, 'codex-home', 'retained-history'), 'utf8')).toBe('isolated-session-history');
    } finally { await removeTempDir(root); }
  });

  it('retains a live bound group home and recovers quarantine after four busy exit cleanups', async () => {
    const root = await createTempDir('happier-connected-service-group-home-live-target-');
    try {
      const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([
        [
          legacyPidSessionTrackingKey(123),
          {
            trackingKey: legacyPidSessionTrackingKey(123),
            startedBy: 'daemon',
            happySessionId: 'session-1',
            pid: 123,
            spawnOptions: {
              directory: '/tmp/project',
              backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
              connectedServices: {
                v: 2,
                bindingsByServiceId: {
                  'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'main',
                    profileId: 'fallback-profile',
                  },
                },
              },
            },
          },
        ],
      ]);
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });

      const scheduler = createConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        trackedSessionsByKey,
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true, path: home });
      await expect(stat(home)).resolves.toBeTruthy();

      trackedSessionsByKey.clear();
      for (let pass = 0; pass < 4; pass += 1) {
        vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
        await expect(scheduler.cleanupPendingDeletedGroupHomes()).rejects.toMatchObject({ code: 'EBUSY' });
        await expect(stat(home)).resolves.toBeTruthy();
      }
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(root);
    }
  });

  it('keeps deleted group homes pending from webhook metadata when spawn options no longer carry bindings', async () => {
    const root = await createTempDir('happier-connected-service-group-home-metadata-target-');
    try {
      const trackedSessionsByKey = new Map<SessionTrackingKey, TrackedSession>([
        [
          legacyPidSessionTrackingKey(123),
          {
            trackingKey: legacyPidSessionTrackingKey(123),
            startedBy: 'daemon',
            happySessionId: 'session-1',
            pid: 123,
            spawnOptions: {
              directory: '/tmp/project',
              backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            },
            happySessionMetadataFromLocalWebhook: {
              path: '/tmp/project',
              host: 'test-host',
              homeDir: '/tmp/home',
              happyHomeDir: '/tmp/home/.happier',
              happyLibDir: '/tmp/home/.happier/lib',
              happyToolsDir: '/tmp/home/.happier/tools',
              connectedServices: {
                v: 2,
                bindingsByServiceId: {
                  'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'main',
                    profileId: 'fallback-profile',
                  },
                },
              },
            },
          },
        ],
      ]);
      const home = resolveConnectedServiceGroupHomeDir({
        activeServerDir: root,
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      });
      await mkdir(home, { recursive: true });

      const scheduler = createConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: root,
        trackedSessionsByKey,
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true, path: home });
      await expect(stat(home)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(root);
    }
  });
});
