import { describe, expect, it, vi } from 'vitest';
import type { PathLike, RmOptions } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { installProviderCli } from './install.js';

function windowsCodexAssetName(): string {
  return `codex-package-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc.tar.gz`;
}

function filesystemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function writeCurrentCodex(installRoot: string, contents: string): Promise<void> {
  const commandPath = join(installRoot, 'current', 'bin', 'codex.exe');
  await mkdir(dirname(commandPath), { recursive: true });
  await writeFile(commandPath, contents, 'utf8');
}

async function installCodexFixture(params: Readonly<{
  homeDir: string;
  logDir: string;
  contents: string;
  removeManagedInstallPath?: typeof rm;
  renameManagedInstallPath?: typeof rename;
}>) {
  return await installProviderCli({
    providerId: 'codex',
    platform: 'win32',
    logDir: params.logDir,
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: params.homeDir,
      PATH: '',
    },
    skipIfInstalled: false,
    deps: {
      fetchGitHubLatestRelease: async () => ({
        assets: [{
          name: windowsCodexAssetName(),
          browser_download_url: 'https://example.invalid/codex.tar.gz',
          digest: 'sha256:test-fixture',
        }],
      }),
      downloadGitHubReleaseAsset: async () => undefined,
      extractGitHubReleaseAsset: async ({ outputDir, archiveEntries }) => {
        for (const entry of archiveEntries ?? []) {
          const destinationPath = join(outputDir ?? '', ...entry.destinationPath.split('/'));
          await mkdir(dirname(destinationPath), { recursive: true });
          await writeFile(destinationPath, `${params.contents}:${entry.destinationPath}`, 'utf8');
        }
      },
      ...(params.removeManagedInstallPath ? { removeManagedInstallPath: params.removeManagedInstallPath } : {}),
      ...(params.renameManagedInstallPath ? { renameManagedInstallPath: params.renameManagedInstallPath } : {}),
    },
  });
}

describe('installProviderCli managed promotion', () => {
  it('serializes concurrent commits for the same managed install root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-concurrent-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-concurrent-log-'));
    const installRoot = join(homeDir, 'tools', 'providers', 'codex');
    const firstRetiredCurrent = deferred();
    const releaseFirstPromotion = deferred();
    try {
      await writeCurrentCodex(installRoot, 'release-zero');
      const firstRename = vi.fn(async (source: string, destination: string) => {
        if (basename(source) === 'current' && basename(destination).startsWith('previous')) {
          await rename(source, destination);
          firstRetiredCurrent.resolve();
          await releaseFirstPromotion.promise;
          return;
        }
        await rename(source, destination);
      }) as typeof rename;

      const firstPromise = installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-one',
        renameManagedInstallPath: firstRename,
      });
      await firstRetiredCurrent.promise;

      const secondPromise = installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-two',
      });
      const secondBeforeRelease = await Promise.race([
        secondPromise.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 150)),
      ]);
      releaseFirstPromotion.resolve();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(secondBeforeRelease).toBe('blocked');
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(await readFile(join(installRoot, 'current', 'bin', 'codex.exe'), 'utf8')).toBe('release-two:bin/codex.exe');
    } finally {
      releaseFirstPromotion.resolve();
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('keeps a promoted current usable when Windows locks the retired binary and allows the next promotion', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-promotion-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-promotion-log-'));
    const installRoot = join(homeDir, 'tools', 'providers', 'codex');
    try {
      await writeCurrentCodex(installRoot, 'release-zero');
      const lockedRetiredPaths: string[] = [];
      const removeManagedInstallPath = vi.fn(async (target: PathLike, options?: RmOptions) => {
        const targetPath = String(target);
        const targetExists = await stat(targetPath).then(() => true, () => false);
        if (targetExists && basename(targetPath).startsWith('previous')) {
          lockedRetiredPaths.push(targetPath);
          throw filesystemError('EPERM', `Windows process lock: ${targetPath}`);
        }
        await rm(target, options);
      }) as typeof rm;

      const first = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-one',
        removeManagedInstallPath,
      });
      const firstCurrent = await readFile(join(installRoot, 'current', 'bin', 'codex.exe'), 'utf8');
      const firstLog = first.logPath ? await readFile(first.logPath, 'utf8') : '';

      const second = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-two',
        removeManagedInstallPath,
      });
      const secondCurrent = await readFile(join(installRoot, 'current', 'bin', 'codex.exe'), 'utf8');
      const retiredDirectories = (await readdir(installRoot)).filter((entry) => entry.startsWith('previous'));

      expect(firstCurrent).toBe('release-one:bin/codex.exe');
      expect(firstLog).toContain('retired release cleanup deferred');
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(secondCurrent).toBe('release-two:bin/codex.exe');
      expect(new Set(lockedRetiredPaths).size).toBe(2);
      expect(retiredDirectories).toHaveLength(2);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('reclaims an owner-generated retired directory on a later install after its Windows lock clears', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-retired-retry-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-retired-retry-log-'));
    const installRoot = join(homeDir, 'tools', 'providers', 'codex');
    try {
      await writeCurrentCodex(installRoot, 'release-zero');
      let initiallyLockedPath: string | null = null;
      let lockFirstCleanup = true;
      const removeManagedInstallPath = vi.fn(async (target: PathLike, options?: RmOptions) => {
        const targetPath = String(target);
        const targetExists = await stat(targetPath).then(() => true, () => false);
        if (targetExists && basename(targetPath).startsWith('previous') && lockFirstCleanup) {
          initiallyLockedPath = targetPath;
          lockFirstCleanup = false;
          throw filesystemError('EPERM', `Windows process lock: ${targetPath}`);
        }
        await rm(target, options);
      }) as typeof rm;

      const first = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-one',
        removeManagedInstallPath,
      });
      expect(first.ok).toBe(true);
      expect(initiallyLockedPath).not.toBeNull();
      if (!initiallyLockedPath) return;
      await expect(stat(initiallyLockedPath)).resolves.toBeDefined();

      const second = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-two',
        removeManagedInstallPath,
      });

      expect(second.ok).toBe(true);
      await expect(stat(initiallyLockedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(installRoot, 'current', 'bin', 'codex.exe'), 'utf8')).toBe('release-two:bin/codex.exe');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('preserves an interrupted-transaction recovery backup when the next promotion also fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-interrupted-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-interrupted-log-'));
    const installRoot = join(homeDir, 'tools', 'providers', 'codex');
    const recoveryPath = join(installRoot, 'previous-00000000-0000-4000-8000-000000000001');
    try {
      await mkdir(join(recoveryPath, 'bin'), { recursive: true });
      await writeFile(join(recoveryPath, 'bin', 'codex.exe'), 'recoverable-release', 'utf8');
      const renameManagedInstallPath = vi.fn(async (source: string, destination: string) => {
        if (basename(source) === 'candidate' && basename(destination) === 'current') {
          throw filesystemError('EACCES', 'next promotion also failed');
        }
        await rename(source, destination);
      }) as typeof rename;

      const result = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'broken-next',
        renameManagedInstallPath,
      });

      expect(result.ok).toBe(false);
      await expect(readFile(join(recoveryPath, 'bin', 'codex.exe'), 'utf8')).resolves.toBe('recoverable-release');
      await expect(stat(join(installRoot, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('keeps post-commit cleanup and its reporting nonthrowing when the install log becomes unavailable', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-cleanup-log-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-cleanup-log-'));
    const installRoot = join(homeDir, 'tools', 'providers', 'codex');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeCurrentCodex(installRoot, 'release-zero');
      const removeManagedInstallPath = vi.fn(async (target: PathLike, options?: RmOptions) => {
        const targetPath = String(target);
        const targetExists = await stat(targetPath).then(() => true, () => false);
        if (targetExists && basename(targetPath).startsWith('previous')) {
          await rm(logDir, { recursive: true, force: true });
          throw filesystemError('EPERM', `Windows process lock: ${targetPath}`);
        }
        await rm(target, options);
      }) as typeof rm;

      const result = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-one',
        removeManagedInstallPath,
      });

      expect(result.ok).toBe(true);
      expect(await readFile(join(installRoot, 'current', 'bin', 'codex.exe'), 'utf8')).toBe('release-one:bin/codex.exe');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('retired release cleanup deferred'));
    } finally {
      warning.mockRestore();
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('reports failure without replacing current when the existing release cannot be retired', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-retire-failure-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-retire-failure-log-'));
    const installRoot = join(homeDir, 'tools', 'providers', 'codex');
    try {
      await writeCurrentCodex(installRoot, 'release-zero');
      const renameManagedInstallPath = vi.fn(async (source: string, destination: string) => {
        if (basename(source) === 'current' && basename(destination).startsWith('previous')) {
          throw filesystemError('EACCES', 'current could not be retired');
        }
        await rename(source, destination);
      }) as typeof rename;

      const result = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-one',
        renameManagedInstallPath,
      });

      expect(result.ok).toBe(false);
      expect(await readFile(join(installRoot, 'current', 'bin', 'codex.exe'), 'utf8')).toBe('release-zero');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('reports promotion failure and restores current when next cannot be promoted', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-promote-failure-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-promote-failure-log-'));
    const installRoot = join(homeDir, 'tools', 'providers', 'codex');
    try {
      await writeCurrentCodex(installRoot, 'release-zero');
      const renameManagedInstallPath = vi.fn(async (source: string, destination: string) => {
        if (basename(source) === 'candidate' && basename(destination) === 'current') {
          throw filesystemError('EACCES', 'next could not be promoted');
        }
        await rename(source, destination);
      }) as typeof rename;

      const result = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-one',
        renameManagedInstallPath,
      });

      expect(result.ok).toBe(false);
      expect(await readFile(join(installRoot, 'current', 'bin', 'codex.exe'), 'utf8')).toBe('release-zero');
      await expect(stat(join(installRoot, 'next'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('returns a truthful precommit failure when both promotion and install-log reporting fail', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-failure-log-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-failure-log-'));
    const installRoot = join(homeDir, 'tools', 'providers', 'codex');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeCurrentCodex(installRoot, 'release-zero');
      const renameManagedInstallPath = vi.fn(async (source: string, destination: string) => {
        if (basename(source) === 'candidate' && basename(destination) === 'current') {
          await rm(logDir, { recursive: true, force: true });
          throw filesystemError('EACCES', 'candidate could not be promoted');
        }
        await rename(source, destination);
      }) as typeof rename;

      const result = await installCodexFixture({
        homeDir,
        logDir,
        contents: 'release-one',
        renameManagedInstallPath,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorMessage).toContain('candidate could not be promoted');
      expect(await readFile(join(installRoot, 'current', 'bin', 'codex.exe'), 'utf8')).toBe('release-zero');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('candidate could not be promoted'));
    } finally {
      warning.mockRestore();
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
