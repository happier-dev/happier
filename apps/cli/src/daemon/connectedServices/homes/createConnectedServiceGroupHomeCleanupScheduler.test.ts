import { mkdir, stat } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { TrackedSession } from '../../types';
import { createConnectedServiceGroupHomeCleanupScheduler } from './createConnectedServiceGroupHomeCleanupScheduler';
import { resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';

describe('createConnectedServiceGroupHomeCleanupScheduler', () => {
  it('keeps deleted group homes pending while a matching tracked session still uses them', async () => {
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
                v: 1,
                bindingsByServiceId: {
                  'openai-codex': {
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
      await expect(scheduler.cleanupPendingDeletedGroupHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: home }),
      ]);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(root);
    }
  });
});
