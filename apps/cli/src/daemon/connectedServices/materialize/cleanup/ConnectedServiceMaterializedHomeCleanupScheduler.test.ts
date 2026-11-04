import { mkdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { buildDefaultConnectedServiceCredentialLifecycleDescriptor } from '../../credentials/lifecycleTypes';
import { ConnectedServiceMaterializedHomeCleanupScheduler } from './ConnectedServiceMaterializedHomeCleanupScheduler';

async function touchOld(path: string, nowMs: number, ageMs: number): Promise<void> {
  const time = new Date(nowMs - ageMs);
  await utimes(path, time, time);
}

describe('ConnectedServiceMaterializedHomeCleanupScheduler', () => {
  it('keeps live and resumable materialized homes while deleting stale orphan homes', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-cleanup-');
    const nowMs = 100_000;
    try {
      const liveHome = join(baseDir, 'csm_live', 'codex');
      const retainedHome = join(baseDir, 'csm_retained', 'claude');
      const recentHome = join(baseDir, 'csm_recent', 'pi');
      const orphanHome = join(baseDir, 'csm_orphan', 'opencode');
      await mkdir(liveHome, { recursive: true });
      await mkdir(retainedHome, { recursive: true });
      await mkdir(recentHome, { recursive: true });
      await mkdir(orphanHome, { recursive: true });
      await touchOld(liveHome, nowMs, 60_000);
      await touchOld(retainedHome, nowMs, 60_000);
      await touchOld(recentHome, nowMs, 1_000);
      await touchOld(orphanHome, nowMs, 60_000);

      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: ({ materializationIdentityId }) => materializationIdentityId === 'csm_live',
        listRetainedIdentityIds: async () => new Set(['csm_retained']),
      });

      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: orphanHome }),
      ]);
      await expect(stat(liveHome)).resolves.toBeTruthy();
      await expect(stat(retainedHome)).resolves.toBeTruthy();
      await expect(stat(recentHome)).resolves.toBeTruthy();
      await expect(stat(orphanHome)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('reaps stale attempt roots only when no active materialization references them', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-attempt-cleanup-');
    const nowMs = 100_000;
    try {
      const attemptsDir = join(baseDir, '.attempts');
      const liveAttempt = join(attemptsDir, 'csm_live-codex-00000000-0000-4000-8000-000000000001');
      const staleAttempt = join(attemptsDir, 'csm_orphan-codex-00000000-0000-4000-8000-000000000002');
      await mkdir(liveAttempt, { recursive: true });
      await mkdir(staleAttempt, { recursive: true });
      await touchOld(liveAttempt, nowMs, 60_000);
      await touchOld(staleAttempt, nowMs, 60_000);

      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: ({ materializationIdentityId }) => materializationIdentityId === 'csm_live',
        listRetainedIdentityIds: async () => new Set(),
      });

      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: staleAttempt }),
      ]);
      await expect(stat(liveAttempt)).resolves.toBeTruthy();
      await expect(stat(staleAttempt)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('deletes stale Claude keychain credentials for removed materialized homes and attempts', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-claude-keychain-cleanup-');
    const nowMs = 100_000;
    try {
      const orphanHome = join(baseDir, 'csm_orphan', 'claude');
      const staleAttempt = join(baseDir, '.attempts', 'csm_orphan-claude-00000000-0000-4000-8000-000000000001');
      const codexHome = join(baseDir, 'csm_codex', 'codex');
      await mkdir(join(orphanHome, 'claude-config'), { recursive: true });
      await mkdir(join(staleAttempt, 'claude-config'), { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await touchOld(orphanHome, nowMs, 60_000);
      await touchOld(staleAttempt, nowMs, 60_000);
      await touchOld(codexHome, nowMs, 60_000);
      const deletedClaudeConfigDirs: string[] = [];

      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: () => false,
        listRetainedIdentityIds: async () => new Set(),
        resolveCredentialLifecycleDescriptor: async (agentId) => ({
          ...buildDefaultConnectedServiceCredentialLifecycleDescriptor(agentId),
          ...(agentId === 'claude'
            ? {
                credentialStorageCleanup: {
                  async deleteCredentialStorageForHomeRoot({ rootDir }) {
                    deletedClaudeConfigDirs.push(join(rootDir, 'claude-config'));
                  },
                },
              }
            : {}),
        }),
      });

      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ cleaned: true, path: orphanHome }),
        expect.objectContaining({ cleaned: true, path: staleAttempt }),
        expect.objectContaining({ cleaned: true, path: codexHome }),
      ]));
      expect(deletedClaudeConfigDirs).toEqual([
        join(orphanHome, 'claude-config'),
        join(staleAttempt, 'claude-config'),
      ]);
      await expect(stat(orphanHome)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(staleAttempt)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(codexHome)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('reads the account Session listing only when a stale home needs a retention decision', async () => {
    // Issue #832: the retention listing pages every active and archived Session with full
    // metadata. A tick with no stale home candidate has no decision to make and reads nothing.
    const baseDir = await createTempDir('happier-connected-service-materialized-retention-demand-');
    const nowMs = 100_000;
    try {
      const recentHome = join(baseDir, 'csm_recent', 'claude');
      const staleAttempt = join(baseDir, '.attempts', 'csm_orphan-codex-00000000-0000-4000-8000-000000000002');
      await mkdir(recentHome, { recursive: true });
      await mkdir(staleAttempt, { recursive: true });
      await touchOld(recentHome, nowMs, 1_000);
      await touchOld(staleAttempt, nowMs, 60_000);

      let listings = 0;
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: () => false,
        listRetainedIdentityIds: async () => {
          listings += 1;
          return new Set(['csm_stale_retained']);
        },
      });

      await scheduler.cleanupPendingMaterializedHomes();
      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: staleAttempt }),
      ]);
      expect(listings).toBe(0);

      const staleRetainedHome = join(baseDir, 'csm_stale_retained', 'claude');
      const staleOrphanHome = join(baseDir, 'csm_stale_orphan', 'claude');
      await mkdir(staleRetainedHome, { recursive: true });
      await mkdir(staleOrphanHome, { recursive: true });
      await touchOld(staleRetainedHome, nowMs, 60_000);
      await touchOld(staleOrphanHome, nowMs, 60_000);
      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([
        expect.objectContaining({ cleaned: true, path: staleOrphanHome }),
      ]);
      expect(listings).toBe(1);
      await expect(stat(staleRetainedHome)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('keeps a queued pending home when its identity becomes retained before child-exit cleanup', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-retained-pending-');
    const nowMs = 100_000;
    try {
      const queuedHome = join(baseDir, 'csm_later_retained', 'codex');
      await mkdir(queuedHome, { recursive: true });
      await touchOld(queuedHome, nowMs, 60_000);

      let live = true;
      const retainedIdentityIds = new Set<string>();
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        hasLiveTarget: () => live,
        listRetainedIdentityIds: async () => retainedIdentityIds,
      });

      await expect(scheduler.reconcileMaterializedHomes()).resolves.toEqual([]);

      live = false;
      retainedIdentityIds.add('csm_later_retained');

      await expect(scheduler.cleanupPendingMaterializedHomes()).resolves.toEqual([]);
      await expect(stat(queuedHome)).resolves.toBeTruthy();
    } finally {
      await removeTempDir(baseDir);
    }
  });

  it('keeps failed cleanup targets retryable and drops them after the retry budget', async () => {
    const baseDir = await createTempDir('happier-connected-service-materialized-cleanup-retry-');
    const nowMs = 100_000;
    try {
      const orphanHome = join(baseDir, 'csm_orphan', 'codex');
      await mkdir(orphanHome, { recursive: true });
      await touchOld(orphanHome, nowMs, 60_000);
      let removeAttempts = 0;
      const removePath: typeof rm = async () => {
        removeAttempts += 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      };
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => nowMs,
        rootTtlMs: 10_000,
        attemptsTtlMs: 10_000,
        maxCleanupRetries: 2,
        removePath,
        onCleanupRetryExhausted: ({ path, attempts, error }) => {
          terminalDiagnostics.push({ path, attempts, error });
        },
        hasLiveTarget: () => false,
        listRetainedIdentityIds: async () => new Set(),
      });
      const terminalDiagnostics: Array<Readonly<{ path: string; attempts: number; error: unknown }>> = [];

      await expect(scheduler.reconcileMaterializedHomes()).rejects.toMatchObject({ code: 'EBUSY' });
      await expect(scheduler.cleanupPendingMaterializedHomes()).rejects.toMatchObject({ code: 'EBUSY' });
      await expect(scheduler.cleanupPendingMaterializedHomes()).resolves.toEqual([]);
      expect(removeAttempts).toBe(2);
      expect(terminalDiagnostics).toEqual([
        expect.objectContaining({ path: orphanHome, attempts: 2, error: expect.objectContaining({ code: 'EBUSY' }) }),
      ]);
    } finally {
      await removeTempDir(baseDir);
    }
  });
});
