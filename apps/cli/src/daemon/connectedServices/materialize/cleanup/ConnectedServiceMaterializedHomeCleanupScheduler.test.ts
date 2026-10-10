import { mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { normalizeMaterializationKeyForPath } from '../normalizeMaterializationKeyForPath';
import { ConnectedServiceMaterializedHomeCleanupScheduler } from './ConnectedServiceMaterializedHomeCleanupScheduler';

async function expectExists(path: string): Promise<void> {
  await expect(stat(path)).resolves.toBeTruthy();
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function createIdentityRoot(baseDir: string, materializationKey: string, agentId = 'codex'): Promise<string> {
  const root = join(baseDir, normalizeMaterializationKeyForPath(materializationKey));
  await mkdir(join(root, agentId), { recursive: true });
  return root;
}

async function touchOld(path: string, mtimeMs: number): Promise<void> {
  const date = new Date(mtimeMs);
  await utimes(path, date, date);
}

describe('ConnectedServiceMaterializedHomeCleanupScheduler', () => {
  it('preserves local transcripts and declared resume state but reclaims homes with only shared symlinks', async () => {
    const root = await createTempDir('happier-home-local-state-');
    try {
      const baseDir = join(root, 'materialized');
      const codex = await createIdentityRoot(baseDir, 'local-codex');
      const claude = await createIdentityRoot(baseDir, 'local-claude', 'happier.agent.claude/claude');
      const declared = await createIdentityRoot(baseDir, 'declared-state', 'other');
      const shared = await createIdentityRoot(baseDir, 'shared-only');
      const outside = join(root, 'shared-sessions');
      await mkdir(outside);
      await writeFile(join(outside, 'rollout.jsonl'), '{}');
      await mkdir(join(codex, 'codex', 'sessions'));
      await writeFile(join(codex, 'codex', 'sessions', 'rollout.jsonl'), '{}');
      await mkdir(join(claude, 'happier.agent.claude', 'claude', 'projects'));
      await writeFile(join(claude, 'happier.agent.claude', 'claude', 'projects', 'session.jsonl'), '{}');
      await writeFile(join(declared, 'other', '.happier-state-sharing.json'), JSON.stringify({
        v: 1, stateEntries: ['native.db'], effectiveStateMode: 'isolated',
      }));
      await writeFile(join(declared, 'other', 'native.db'), 'resume state');
      await symlink(outside, join(shared, 'codex', 'sessions'), 'dir');
      const isolationBaseDir = join(root, 'isolation');
      const isolated = join(isolationBaseDir, 'codex', 'execution_run', 'local-isolated');
      await mkdir(join(isolated, 'xdg', 'state'), { recursive: true });
      await writeFile(join(isolated, 'xdg', 'state', 'native.db'), 'resume state');
      for (const home of [codex, claude, declared, shared, isolated]) await touchOld(home, 1_000);
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, isolationBaseDir, nowMs: () => 10_000, orphanTtlMs: 1_000,
        getLiveMaterializationKeys: () => [], getRetainedMaterializationKeys: async () => [],
      });
      await scheduler.reconcile();
      for (const home of [codex, claude, declared, isolated]) await expectExists(home);
      await expectMissing(shared);
      await expectExists(outside);
    } finally { await removeTempDir(root); }
  });

  it('reclaims orphan execution-run isolation homes through the same retention sweep', async () => {
    const root = await createTempDir('happier-isolation-home-cleanup-');
    try {
      const isolationBaseDir = join(root, 'isolation');
      const retained = join(isolationBaseDir, 'codex', 'execution_run', 'retained-run');
      const orphan = join(isolationBaseDir, 'happier.agent.pi', 'pi', 'execution_run', 'orphan-run');
      const unknownScope = join(isolationBaseDir, 'claude', 'session', 'unknown');
      for (const home of [retained, orphan, unknownScope]) {
        await mkdir(home, { recursive: true });
        await touchOld(home, 1_000);
      }
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir: join(root, 'materialized'), isolationBaseDir,
        nowMs: () => 10_000, orphanTtlMs: 1_000,
        getLiveMaterializationKeys: () => [],
        getRetainedMaterializationKeys: async () => ['retained-run'],
      });
      await scheduler.reconcile();
      await expectMissing(orphan);
      await expectExists(retained);
      await expectExists(unknownScope);
    } finally { await removeTempDir(root); }
  });

  it('keeps isolation homes when retention is unknown or their scope escapes through a symlink', async () => {
    const root = await createTempDir('happier-isolation-home-cleanup-safety-');
    const outside = await createTempDir('happier-isolation-home-outside-');
    try {
      const isolationBaseDir = join(root, 'isolation');
      const orphan = join(isolationBaseDir, 'pi', 'execution_run', 'orphan');
      await mkdir(orphan, { recursive: true });
      await touchOld(orphan, 1_000);
      const createScheduler = (available: boolean) => new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir: join(root, 'materialized'), isolationBaseDir,
        nowMs: () => 10_000, orphanTtlMs: 1_000,
        getLiveMaterializationKeys: () => [],
        getRetainedMaterializationKeys: async () => available ? [] : { status: 'unavailable' },
      });
      await createScheduler(false).reconcile();
      await expectExists(orphan);
      const outsideHome = join(outside, 'native-state');
      await mkdir(outsideHome);
      await touchOld(outsideHome, 1_000);
      await mkdir(join(isolationBaseDir, 'codex'), { recursive: true });
      await symlink(outside, join(isolationBaseDir, 'codex', 'execution_run'), 'dir');
      await createScheduler(true).reconcile();
      await expectMissing(orphan);
      await expectExists(outsideHome);
    } finally { await removeTempDir(root); await removeTempDir(outside); }
  });

  it('retains live and resumable identity roots while pruning stale orphan roots and attempts', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-');
    try {
      const baseDir = join(root, 'materialized');
      const liveRoot = await createIdentityRoot(baseDir, 'live-identity', 'codex');
      const resumableRoot = await createIdentityRoot(baseDir, 'resumable-identity', 'gemini');
      const staleOrphanRoot = await createIdentityRoot(baseDir, 'stale-orphan', 'opencode');
      const recentOrphanRoot = await createIdentityRoot(baseDir, 'recent-orphan', 'claude');
      const attemptsRoot = join(baseDir, '.attempts');
      const staleAttempt = join(attemptsRoot, 'stale-attempt');
      const recentAttempt = join(attemptsRoot, 'recent-attempt');
      await mkdir(staleAttempt, { recursive: true });
      await mkdir(recentAttempt, { recursive: true });
      await touchOld(staleOrphanRoot, 1_000);
      await touchOld(recentOrphanRoot, 9_500);
      await touchOld(staleAttempt, 1_000);
      await touchOld(recentAttempt, 9_500);

      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 5_000,
        attemptTtlMs: 1_000,
        getLiveMaterializationKeys: () => ['live-identity'],
        getRetainedMaterializationKeys: async () => ['resumable-identity'],
      });

      await expect(scheduler.reconcile()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: staleOrphanRoot, cleaned: true, targetKind: 'identity_root' }),
        expect.objectContaining({ path: staleAttempt, cleaned: true, targetKind: 'attempt_root' }),
      ]));
      await expectExists(liveRoot);
      await expectExists(resumableRoot);
      await expectMissing(staleOrphanRoot);
      await expectExists(recentOrphanRoot);
      await expectMissing(staleAttempt);
      await expectExists(recentAttempt);
    } finally {
      await removeTempDir(root);
    }
  });

  it('retries failed deletes and then stops retrying an abandoned root in the same daemon', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-retry-');
    try {
      const baseDir = join(root, 'materialized');
      const orphanRoot = await createIdentityRoot(baseDir, 'busy-orphan', 'codex');
      await touchOld(orphanRoot, 1_000);
      const removePath = vi.fn(async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      });
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        maxCleanupRetries: 2,
        removePath,
        getLiveMaterializationKeys: () => [],
        getRetainedMaterializationKeys: async () => [],
      });

      await expect(scheduler.reconcile()).rejects.toMatchObject({ code: 'EBUSY' });
      await expect(scheduler.reconcile()).rejects.toMatchObject({ code: 'EBUSY' });
      await expect(scheduler.reconcile()).resolves.toEqual([
        expect.objectContaining({
          path: orphanRoot,
          cleaned: false,
          abandoned: true,
          targetKind: 'identity_root',
        }),
      ]);

      expect(removePath).toHaveBeenCalledTimes(2);
      await expectExists(orphanRoot);
    } finally {
      await removeTempDir(root);
    }
  });

  it('bounds hung path cleanup attempts and then stops retrying the root in the same daemon', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-timeout-');
    try {
      const baseDir = join(root, 'materialized');
      const orphanRoot = await createIdentityRoot(baseDir, 'hung-orphan', 'codex');
      await touchOld(orphanRoot, 1_000);
      const removePath = vi.fn(() => new Promise<never>(() => undefined));
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        maxCleanupRetries: 2,
        fileOperationTimeoutMs: 25,
        removePath,
        getLiveMaterializationKeys: () => [],
        getRetainedMaterializationKeys: async () => [],
      });

      await expect(scheduler.reconcile()).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        operation: 'rm',
        path: orphanRoot,
      });

      await expect(scheduler.reconcile()).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        operation: 'rm',
        path: orphanRoot,
      });

      await expect(scheduler.reconcile()).resolves.toEqual([
        expect.objectContaining({
          path: orphanRoot,
          cleaned: false,
          abandoned: true,
          targetKind: 'identity_root',
        }),
      ]);

      expect(removePath).toHaveBeenCalledTimes(2);
      await expectExists(orphanRoot);
    } finally {
      await removeTempDir(root);
    }
  });

  it('rechecks retained identity roots immediately before deletion', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-race-');
    try {
      const baseDir = join(root, 'materialized');
      const materializationKey = 'race-retained';
      const retainedRoot = await createIdentityRoot(baseDir, materializationKey, 'codex');
      await touchOld(retainedRoot, 1_000);
      const removePath = vi.fn(async () => undefined);
      const retainedReads = vi
        .fn<() => Promise<Iterable<string>>>()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([materializationKey]);
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        removePath,
        getLiveMaterializationKeys: () => [],
        getRetainedMaterializationKeys: retainedReads,
      });

      await expect(scheduler.reconcile()).resolves.toEqual([
        expect.objectContaining({
          path: retainedRoot,
          cleaned: false,
          retained: true,
          targetKind: 'identity_root',
        }),
      ]);

      expect(retainedReads).toHaveBeenCalledTimes(2);
      expect(removePath).not.toHaveBeenCalled();
      await expectExists(retainedRoot);
    } finally {
      await removeTempDir(root);
    }
  });

  it('skips identity-root deletion when retained-session scan is unavailable', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-retained-unavailable-');
    try {
      const baseDir = join(root, 'materialized');
      const orphanRoot = await createIdentityRoot(baseDir, 'possibly-resumable', 'codex');
      const attemptsRoot = join(baseDir, '.attempts');
      const staleAttempt = join(attemptsRoot, 'stale-attempt');
      await mkdir(staleAttempt, { recursive: true });
      await touchOld(orphanRoot, 1_000);
      await touchOld(staleAttempt, 1_000);
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        getLiveMaterializationKeys: () => [],
        getRetainedMaterializationKeys: async () => ({ status: 'unavailable' }),
      });

      await expect(scheduler.reconcile()).resolves.toEqual([
        expect.objectContaining({ path: staleAttempt, cleaned: true, targetKind: 'attempt_root' }),
      ]);
      await expectExists(orphanRoot);
      await expectMissing(staleAttempt);
    } finally {
      await removeTempDir(root);
    }
  });

  it('applies the injected retained-home sanitizer to each retained materialized home', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-retained-sanitizer-');
    try {
      const baseDir = join(root, 'materialized');
      const materializationKey = 'live-home';
      const liveRoot = await createIdentityRoot(baseDir, materializationKey, 'claude');
      const retainedKey = 'retained-home';
      const retainedRoot = await createIdentityRoot(baseDir, retainedKey, 'claude');

      const sanitizedHomeRoots: string[] = [];
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        getLiveMaterializationKeys: () => [materializationKey],
        getRetainedMaterializationKeys: async () => [retainedKey],
        sanitizeRetainedMaterializedHome: async (homeRootDir) => {
          sanitizedHomeRoots.push(homeRootDir);
        },
      });

      await expect(scheduler.reconcile()).resolves.toEqual([]);
      expect(sanitizedHomeRoots.sort()).toEqual([liveRoot, retainedRoot].sort());
    } finally {
      await removeTempDir(root);
    }
  });

  it('never invokes a retained-home sanitizer when none is contributed', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-no-sanitizer-');
    try {
      const baseDir = join(root, 'materialized');
      const materializationKey = 'live-home';
      await createIdentityRoot(baseDir, materializationKey, 'claude');
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        getLiveMaterializationKeys: () => [materializationKey],
        getRetainedMaterializationKeys: async () => [],
      });
      await expect(scheduler.reconcile()).resolves.toEqual([]);
    } finally {
      await removeTempDir(root);
    }
  });

  it('does not delete a root that is replaced by a symlink before deletion', async () => {
    const root = await createTempDir('happier-materialized-home-cleanup-symlink-');
    const outside = await createTempDir('happier-materialized-home-cleanup-outside-');
    try {
      const baseDir = join(root, 'materialized');
      const materializationKey = 'symlink-race';
      const targetRoot = await createIdentityRoot(baseDir, materializationKey, 'codex');
      await touchOld(targetRoot, 1_000);
      const removePath = vi.fn(async () => undefined);
      const retainedReads = vi.fn(async () => {
        if (retainedReads.mock.calls.length === 2) {
          await rm(targetRoot, { recursive: true, force: true });
          await symlink(outside, targetRoot, 'dir');
        }
        return [];
      });
      const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir,
        nowMs: () => 10_000,
        orphanTtlMs: 1_000,
        attemptTtlMs: 1_000,
        removePath,
        getLiveMaterializationKeys: () => [],
        getRetainedMaterializationKeys: retainedReads,
      });

      await expect(scheduler.reconcile()).resolves.toEqual([
        expect.objectContaining({
          path: targetRoot,
          cleaned: false,
          retained: true,
          targetKind: 'identity_root',
        }),
      ]);

      expect(removePath).not.toHaveBeenCalled();
      await expectExists(outside);
    } finally {
      await removeTempDir(root);
      await removeTempDir(outside);
    }
  });
});
