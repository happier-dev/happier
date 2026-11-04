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

  it.each([
    ['invalid JSON', '{"activeServerId":"selfhost",}'],
    ['invalid root', 'null'],
    ['failed migration', JSON.stringify({ schemaVersion: 5, servers: { selfhost: { serverUrl: { toString: null, valueOf: null } } } })],
  ])('preserves settings and releases the lock after %s', async (_reason, content) => {
    const { configuration } = await import('@/configuration');
    const { readSettings, updateSettings } = await import('@/persistence');
    await writeFile(configuration.settingsFile, content);

    // Read-only callers retain their existing best-effort defaults.
    expect((await readSettings()).onboardingCompleted).toBe(false);
    let updaterRan = false;
    await expect(updateSettings((current) => {
      updaterRan = true;
      return { ...current, daemonAutoStartWhenRunningHappy: true };
    })).rejects.toThrow();

    expect(updaterRan).toBe(false);
    expect(await readFile(configuration.settingsFile, 'utf8')).toBe(content);
    expect(existsSync(`${configuration.settingsFile}.lock`)).toBe(false);
    expect(existsSync(`${configuration.settingsFile}.tmp`)).toBe(false);

    // Once the user repairs the file, a fresh update can proceed.
    await writeFile(configuration.settingsFile, JSON.stringify({ schemaVersion: 6, onboardingCompleted: true }));
    await updateSettings((current) => ({ ...current, daemonAutoStartWhenRunningHappy: true }));
    expect(await readSettings()).toMatchObject({ onboardingCompleted: true, daemonAutoStartWhenRunningHappy: true });
  });

  it.each(['EBUSY', 'EPERM', 'EACCES'])('preserves settings when reading fails with %s', async (code) => {
    let failRead = true;
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        // Filesystem failures are the OS boundary; parsing, migration and locking stay real.
        readFile: async (...args: Parameters<typeof actual.readFile>) => {
          if (failRead && String(args[0]).endsWith('settings.json')) {
            throw Object.assign(new Error('Settings file is unavailable'), { code });
          }
          return actual.readFile(...args);
        },
      };
    });
    const { configuration } = await import('@/configuration');
    const { readSettings, updateSettings } = await import('@/persistence');
    const saved = {
      schemaVersion: 6,
      onboardingCompleted: true,
      activeServerId: 'selfhost',
      servers: { selfhost: { id: 'selfhost', name: 'Self-hosted', serverUrl: 'https://example.test', webappUrl: 'https://example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 } },
      machineIdByServerId: { selfhost: 'machine-selfhost' },
      lastChangesCursorByServerIdByAccountId: { selfhost: { account: 4242 } },
    };
    const content = JSON.stringify(saved);
    await writeFile(configuration.settingsFile, content);
    let updaterRan = false;

    await expect(updateSettings((current) => {
      updaterRan = true;
      return { ...current, daemonAutoStartWhenRunningHappy: true };
    })).rejects.toMatchObject({ code });

    expect(updaterRan).toBe(false);
    expect(await readFile(configuration.settingsFile, 'utf8')).toBe(content);
    expect(existsSync(`${configuration.settingsFile}.lock`)).toBe(false);
    expect(existsSync(`${configuration.settingsFile}.tmp`)).toBe(false);
    failRead = false;
    await updateSettings((current) => ({ ...current, daemonAutoStartWhenRunningHappy: true }));
    expect(await readSettings()).toMatchObject({ ...saved, daemonAutoStartWhenRunningHappy: true });
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
    expect(Date.now() - startedAt).toBeLessThan(3_000);
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
      expect(Date.now() - startedAt).toBeLessThan(3_000);
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
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('retries transient Windows-style rename lock failures when promoting settings.json.tmp', async () => {
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let remainingRenameFailures = 2;

      return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
          if (remainingRenameFailures > 0) {
            remainingRenameFailures -= 1;
            const error = Object.assign(
              new Error('EPERM: operation not permitted, rename settings.json.tmp -> settings.json'),
              { code: 'EPERM' as const },
            );
            throw error;
          }
          return actual.rename(...args);
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
    const persisted = JSON.parse(await readFile(configuration.settingsFile, 'utf8')) as {
      onboardingCompleted?: boolean;
    };
    expect(persisted.onboardingCompleted).toBe(true);
  });
});
