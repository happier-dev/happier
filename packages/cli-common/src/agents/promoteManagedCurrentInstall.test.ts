import type { RmOptions } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { failingRenameTargets, filesystemFailureState } = vi.hoisted(() => ({
  failingRenameTargets: new Map<string, number>(),
  filesystemFailureState: {
    failCurrentRetirementOnce: false,
    backupCleanupFailuresRemaining: 0,
    pausedPromotionSource: null as string | null,
    onPromotionPaused: null as (() => void) | null,
    promotionRelease: null as Promise<void> | null,
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (filesystemFailureState.pausedPromotionSource === from) {
        filesystemFailureState.pausedPromotionSource = null;
        filesystemFailureState.onPromotionPaused?.();
        await filesystemFailureState.promotionRelease;
      }
      if (
        filesystemFailureState.failCurrentRetirementOnce
        && /(?:^|[\\/])current$/.test(from)
        && /(?:^|[\\/])\.current\.backup-/.test(to)
      ) {
        filesystemFailureState.failCurrentRetirementOnce = false;
        const error = new Error(`EACCES: mocked retirement failure, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      const remainingFailures = failingRenameTargets.get(to) ?? 0;
      if (remainingFailures > 0) {
        if (remainingFailures === 1) {
          failingRenameTargets.delete(to);
        } else {
          failingRenameTargets.set(to, remainingFailures - 1);
        }
        const error = new Error(`EXDEV: mocked promotion failure, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      }
      return await actual.rename(from, to);
    }),
    rm: vi.fn(async (path: string, options?: RmOptions) => {
      const isBackup = /(?:^|[\\/])\.current\.backup-/.test(path);
      const exists = isBackup && await actual.lstat(path).then(() => true, () => false);
      if (filesystemFailureState.backupCleanupFailuresRemaining > 0 && exists) {
        filesystemFailureState.backupCleanupFailuresRemaining -= 1;
        const error = new Error(`EPERM: mocked Windows process lock, unlink '${path}'`) as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return await actual.rm(path, options);
    }),
  };
});

const tempDirs = new Set<string>();

async function makeTempRoot(): Promise<string> {
  const root = join(tmpdir(), `happier-managed-current-promotion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.add(root);
  await mkdir(root, { recursive: true });
  return root;
}

describe('promoteManagedCurrentInstall', () => {
  afterEach(async () => {
    failingRenameTargets.clear();
    filesystemFailureState.failCurrentRetirementOnce = false;
    filesystemFailureState.backupCleanupFailuresRemaining = 0;
    filesystemFailureState.pausedPromotionSource = null;
    filesystemFailureState.onPromotionPaused = null;
    filesystemFailureState.promotionRelease = null;
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.clear();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('serializes concurrent promotions for the same managed install root', async () => {
    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const firstCandidate = join(installRoot, 'candidate-one');
    const secondCandidate = join(installRoot, 'candidate-two');
    let signalPaused!: () => void;
    const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
    let releasePromotion!: () => void;
    const release = new Promise<void>((resolve) => { releasePromotion = resolve; });

    await mkdir(join(firstCandidate, 'bin'), { recursive: true });
    await writeFile(join(firstCandidate, 'bin', 'tool'), 'release-one', 'utf8');
    await mkdir(join(secondCandidate, 'bin'), { recursive: true });
    await writeFile(join(secondCandidate, 'bin', 'tool'), 'release-two', 'utf8');
    filesystemFailureState.pausedPromotionSource = firstCandidate;
    filesystemFailureState.onPromotionPaused = signalPaused;
    filesystemFailureState.promotionRelease = release;

    const firstPromise = promoteManagedCurrentInstall({ installRoot, candidatePath: firstCandidate });
    await paused;
    const secondPromise = promoteManagedCurrentInstall({ installRoot, candidatePath: secondCandidate });
    const secondBeforeRelease = await Promise.race([
      secondPromise.then(() => 'settled' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 150)),
    ]);
    releasePromotion();

    await expect(firstPromise).resolves.toBeUndefined();
    await expect(secondPromise).resolves.toBeUndefined();
    expect(secondBeforeRelease).toBe('blocked');
    await expect(readFile(join(currentPath, 'bin', 'tool'), 'utf8')).resolves.toBe('release-two');
  });

  it('keeps the managed binary command reachable while an update is being activated', async () => {
    if (process.platform === 'win32') return;

    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const candidatePath = join(installRoot, 'candidate');
    const currentCommandPath = join(currentPath, 'bin', 'tool');
    const activeCommandPath = join(installRoot, 'active', 'bin', 'tool');
    let signalPaused!: () => void;
    const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
    let releasePromotion!: () => void;
    const release = new Promise<void>((resolve) => { releasePromotion = resolve; });

    await mkdir(join(currentPath, 'bin'), { recursive: true });
    await writeFile(currentCommandPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(currentCommandPath, 0o755);
    await mkdir(join(candidatePath, 'bin'), { recursive: true });
    await writeFile(join(candidatePath, 'bin', 'tool'), '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(join(candidatePath, 'bin', 'tool'), 0o755);
    filesystemFailureState.pausedPromotionSource = candidatePath;
    filesystemFailureState.onPromotionPaused = signalPaused;
    filesystemFailureState.promotionRelease = release;

    const promotion = promoteManagedCurrentInstall({
      installRoot,
      candidatePath,
      activateVersionedRelease: true,
    });
    await paused;

    expect(spawnSync(currentCommandPath).status).toBe(0);
    releasePromotion();
    await expect(promotion).resolves.toBeUndefined();
    expect(spawnSync(currentCommandPath).status).toBe(0);
    expect(spawnSync(activeCommandPath).status).toBe(0);
  });

  it('keeps promoted current usable when Windows locks the retired binary and allows the next promotion', async () => {
    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const nextPath = join(installRoot, 'next');
    const binaryPath = join(currentPath, 'bin', 'tool');

    await mkdir(join(currentPath, 'bin'), { recursive: true });
    await writeFile(binaryPath, 'release-zero', 'utf8');
    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'release-one', 'utf8');
    filesystemFailureState.backupCleanupFailuresRemaining = 3;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(promoteManagedCurrentInstall({ installRoot })).resolves.toBeUndefined();
    await expect(readFile(binaryPath, 'utf8')).resolves.toBe('release-one');

    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'release-two', 'utf8');

    await expect(promoteManagedCurrentInstall({ installRoot })).resolves.toBeUndefined();
    await expect(readFile(binaryPath, 'utf8')).resolves.toBe('release-two');
    const retainedBackups = (await readdir(installRoot)).filter((entry) => entry.startsWith('.current.backup-'));
    expect(retainedBackups).toHaveLength(2);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('retired managed install cleanup deferred'));
  });

  it('reclaims an owner-generated backup on a later promotion after its lock clears', async () => {
    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const nextPath = join(installRoot, 'next');

    await mkdir(join(currentPath, 'bin'), { recursive: true });
    await writeFile(join(currentPath, 'bin', 'tool'), 'release-zero', 'utf8');
    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'release-one', 'utf8');
    filesystemFailureState.backupCleanupFailuresRemaining = 1;
    await promoteManagedCurrentInstall({ installRoot });
    const retainedBackup = (await readdir(installRoot)).find((entry) => entry.startsWith('.current.backup-'));
    expect(retainedBackup).toBeDefined();
    if (!retainedBackup) return;

    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'release-two', 'utf8');
    await promoteManagedCurrentInstall({ installRoot });

    await expect(readFile(join(currentPath, 'bin', 'tool'), 'utf8')).resolves.toBe('release-two');
    expect(await readdir(installRoot)).not.toContain(retainedBackup);
  });

  it('preserves an interrupted-transaction recovery backup when the next promotion also fails', async () => {
    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const nextPath = join(installRoot, 'next');
    const recoveryPath = join(installRoot, '.current.backup-1234-00000000-0000-4000-8000-000000000001');

    await mkdir(join(recoveryPath, 'bin'), { recursive: true });
    await writeFile(join(recoveryPath, 'bin', 'tool'), 'recoverable-release', 'utf8');
    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'broken-next', 'utf8');
    failingRenameTargets.set(currentPath, 1);

    await expect(promoteManagedCurrentInstall({ installRoot })).rejects.toThrow(/promotion failure/i);
    await expect(readFile(join(recoveryPath, 'bin', 'tool'), 'utf8')).resolves.toBe('recoverable-release');
    await expect(readFile(join(currentPath, 'bin', 'tool'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports failure without replacing current when the existing release cannot be retired', async () => {
    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const nextPath = join(installRoot, 'next');
    const binaryPath = join(currentPath, 'bin', 'tool');

    await mkdir(join(currentPath, 'bin'), { recursive: true });
    await writeFile(binaryPath, 'old-current', 'utf8');
    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'new-next', 'utf8');
    filesystemFailureState.failCurrentRetirementOnce = true;

    await expect(promoteManagedCurrentInstall({ installRoot })).rejects.toThrow(/retirement failure/i);
    await expect(readFile(binaryPath, 'utf8')).resolves.toBe('old-current');
  });

  it('restores the previous current install when final candidate promotion fails', async () => {
    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const nextPath = join(installRoot, 'next');
    const binaryPath = join(currentPath, 'bin', 'tool');

    await mkdir(join(currentPath, 'bin'), { recursive: true });
    await writeFile(binaryPath, 'old-current', 'utf8');
    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'new-next', 'utf8');
    failingRenameTargets.set(currentPath, 1);

    await expect(promoteManagedCurrentInstall({ installRoot })).rejects.toThrow(/promotion failure/i);

    await expect(readFile(binaryPath, 'utf8')).resolves.toBe('old-current');
    await expect(readFile(join(nextPath, 'bin', 'tool'), 'utf8')).resolves.toBe('new-next');
  });

  it('reports when promotion fails and the previous current install cannot be restored', async () => {
    const { promoteManagedCurrentInstall } = await import('./promoteManagedCurrentInstall.js');
    const installRoot = await makeTempRoot();
    const currentPath = join(installRoot, 'current');
    const nextPath = join(installRoot, 'next');

    await mkdir(join(currentPath, 'bin'), { recursive: true });
    await writeFile(join(currentPath, 'bin', 'tool'), 'old-current', 'utf8');
    await mkdir(join(nextPath, 'bin'), { recursive: true });
    await writeFile(join(nextPath, 'bin', 'tool'), 'new-next', 'utf8');
    failingRenameTargets.set(currentPath, 2);

    await expect(promoteManagedCurrentInstall({ installRoot })).rejects.toThrow(/could not be restored/i);
  });
});
