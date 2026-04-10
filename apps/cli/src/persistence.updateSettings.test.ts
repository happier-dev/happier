import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
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
});
