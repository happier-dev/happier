import { mkdir, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { TrackedSession } from '../../../types';
import { normalizeMaterializationKeyForPath } from '../normalizeMaterializationKeyForPath';
import { createConnectedServiceMaterializedHomeCleanupScheduler } from './createConnectedServiceMaterializedHomeCleanupScheduler';

async function createIdentityRoot(baseDir: string, materializationKey: string): Promise<string> {
  const root = join(baseDir, normalizeMaterializationKeyForPath(materializationKey));
  await mkdir(join(root, 'codex'), { recursive: true });
  await utimes(root, new Date(1_000), new Date(1_000));
  return root;
}

describe('createConnectedServiceMaterializedHomeCleanupScheduler', () => {
  it('retains live tracked-session and resumable materialization identities', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-factory-');
    try {
      const baseDir = join(root, 'materialized');
      const liveRoot = await createIdentityRoot(baseDir, 'live-identity');
      const resumableRoot = await createIdentityRoot(baseDir, 'resumable-identity');
      const orphanRoot = await createIdentityRoot(baseDir, 'orphan-identity');
      const pidToTrackedSession = new Map<number, TrackedSession>([
        [123, {
          startedBy: 'daemon',
          pid: 123,
          spawnOptions: {
            directory: '/repo',
            connectedServiceMaterializationIdentityV1: {
              v: 1,
              id: 'live-identity',
              createdAt: 1_000,
            },
          },
        }],
      ]);

      const scheduler = createConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        pidToTrackedSession,
        getRetainedMaterializationKeys: async () => ['resumable-identity'],
      });

      await scheduler.reconcile();

      await expect(stat(liveRoot)).resolves.toBeTruthy();
      await expect(stat(resumableRoot)).resolves.toBeTruthy();
      await expect(stat(orphanRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(root);
    }
  });
});
