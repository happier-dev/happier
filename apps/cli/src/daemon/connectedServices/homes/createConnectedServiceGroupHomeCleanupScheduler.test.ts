import { mkdir, rename, stat } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { TrackedSession } from '../../types';
import { createConnectedServiceGroupHomeCleanupScheduler } from './createConnectedServiceGroupHomeCleanupScheduler';
import { resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';

// Only filesystem rename is faulted; tracked binding parsing, factory wiring,
// group-home selection and eventual quarantine use their real owners.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe('createConnectedServiceGroupHomeCleanupScheduler', () => {
  it('retains a live bound group home and recovers quarantine after four busy exit cleanups', async () => {
    const root = await createTempDir('happier-connected-service-group-home-live-target-');
    try {
      const pidToTrackedSession = new Map<number, TrackedSession>([
        [
          123,
          {
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
        pidToTrackedSession,
      });

      await expect(scheduler.scheduleDeletedGroupCleanup({
        serviceId: 'openai-codex',
        groupId: 'main',
        agentId: 'codex',
      })).resolves.toMatchObject({ cleaned: false, pending: true, path: home });
      await expect(stat(home)).resolves.toBeTruthy();

      pidToTrackedSession.clear();
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
      const pidToTrackedSession = new Map<number, TrackedSession>([
        [
          123,
          {
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
        pidToTrackedSession,
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
