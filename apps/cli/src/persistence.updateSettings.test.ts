import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('updateSettings', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR']);
  let tempRootDir: string | undefined;
  let homeDir: string | undefined;

  beforeEach(async () => {
    tempRootDir = await createTempDir('happier-cli-update-settings-');
    homeDir = join(tempRootDir, 'missing-home');
    applyEnvValues({ HAPPIER_HOME_DIR: homeDir });
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
    vi.unstubAllGlobals();
    if (tempRootDir) {
      await removeTempDir(tempRootDir);
    }
    tempRootDir = undefined;
    homeDir = undefined;
  });

  it('recreates the home dir before acquiring the settings lock', async () => {
    const { configuration } = await import('@/configuration');
    const { updateSettings } = await import('@/persistence');

    await rm(configuration.happyHomeDir, { recursive: true, force: true });

    const updated = await updateSettings((current) => ({
      ...current,
      onboardingCompleted: true,
    }));

    expect(updated.onboardingCompleted).toBe(true);
    expect(existsSync(configuration.happyHomeDir)).toBe(true);
    expect(existsSync(configuration.settingsFile)).toBe(true);
    expect(existsSync(`${configuration.settingsFile}.lock`)).toBe(false);
    if (process.platform !== 'win32') {
      const homeStats = await stat(configuration.happyHomeDir);
      expect(homeStats.mode & 0o077).toBe(0);
    }

    const persisted = JSON.parse(await readFile(configuration.settingsFile, 'utf8')) as {
      onboardingCompleted?: boolean;
    };
    expect(persisted.onboardingCompleted).toBe(true);
  });

  it('recovers when lock acquisition sees a transient missing-home ENOENT', async () => {
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let shouldFailFirstLockOpen = true;

      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const [path] = args;
          if (shouldFailFirstLockOpen && String(path).endsWith('settings.json.lock')) {
            shouldFailFirstLockOpen = false;
            await actual.rm(homeDir!, { recursive: true, force: true });
            const error = Object.assign(
              new Error(`ENOENT: no such file or directory, open '${String(path)}'`),
              { code: 'ENOENT' as const },
            );
            throw error;
          }
          return actual.open(...args);
        },
      };
    });

    const { configuration } = await import('@/configuration');
    const { updateSettings } = await import('@/persistence');

    const updated = await updateSettings((current) => ({
      ...current,
      onboardingCompleted: true,
    }));

    expect(updated.onboardingCompleted).toBe(true);
    expect(existsSync(configuration.happyHomeDir)).toBe(true);
    expect(existsSync(configuration.settingsFile)).toBe(true);
    expect(existsSync(`${configuration.settingsFile}.lock`)).toBe(false);
  });

  it('acquires the settings lock with string flags for Bun-compatible Windows runtimes', async () => {
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const [path, flags] = args;
          if (String(path).endsWith('settings.json.lock') && typeof flags === 'number') {
            const error = Object.assign(
              new Error(`ENOENT: no such file or directory, open '${String(path)}'`),
              { code: 'ENOENT' as const },
            );
            throw error;
          }
          return actual.open(...args);
        },
      };
    });

    const { configuration } = await import('@/configuration');
    const { updateSettings } = await import('@/persistence');

    const updated = await updateSettings((current) => ({
      ...current,
      onboardingCompleted: true,
    }));

    expect(updated.onboardingCompleted).toBe(true);
    expect(existsSync(configuration.settingsFile)).toBe(true);
    expect(existsSync(`${configuration.settingsFile}.lock`)).toBe(false);
  });

  it('breaks a settings lock left behind by a dead pid owner before the stale timeout elapses', async () => {
    const { configuration } = await import('@/configuration');
    const { updateSettings } = await import('@/persistence');

    const helper = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    const helperPid = helper.pid;
    expect(typeof helperPid).toBe('number');

    await new Promise<void>((resolve, reject) => {
      helper.once('exit', () => resolve());
      helper.once('error', reject);
    });

    const lockFile = `${configuration.settingsFile}.lock`;
    await writeFile(lockFile, `${helperPid}\n`, 'utf8');

    const startedAt = Date.now();
    const updated = await updateSettings((current) => ({
      ...current,
      onboardingCompleted: true,
    }));

    expect(updated.onboardingCompleted).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
    // Runtime speed here is not a product contract; keep this as a loose hang guard.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('breaks a settings lock whose live owner pid no longer belongs to a Happier process', async () => {
    const { configuration } = await import('@/configuration');
    const { updateSettings } = await import('@/persistence');

    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const helperPid = helper.pid;
    expect(typeof helperPid).toBe('number');

    const lockFile = `${configuration.settingsFile}.lock`;
    await writeFile(lockFile, `${helperPid}\n`, 'utf8');

    try {
      const startedAt = Date.now();
      const updated = await updateSettings((current) => ({
        ...current,
        onboardingCompleted: true,
      }));

      expect(updated.onboardingCompleted).toBe(true);
      expect(existsSync(lockFile)).toBe(false);
      // Runtime speed here is not a product contract; keep this as a loose hang guard.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      helper.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        helper.once('exit', () => resolve());
      });
    }
  });

  it('breaks an empty settings lock left behind before the owner pid was written', async () => {
    const { configuration } = await import('@/configuration');
    const { updateSettings } = await import('@/persistence');

    const lockFile = `${configuration.settingsFile}.lock`;
    await writeFile(lockFile, '', 'utf8');

    const staleTime = new Date(Date.now() - 5_000);
    await utimes(lockFile, staleTime, staleTime);

    const startedAt = Date.now();
    const updated = await updateSettings((current) => ({
      ...current,
      onboardingCompleted: true,
    }));

    expect(updated.onboardingCompleted).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
    // Runtime speed here is not a product contract; keep this as a loose hang guard.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});
