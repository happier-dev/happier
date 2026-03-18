import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureManagedPnpmCommand, managedPnpmBinPath, managedPnpmInstallDir } from './managedPnpm.js';

vi.mock('@happier-dev/release-runtime', () => ({
  fetchGitHubLatestRelease: async () => ({
    tag_name: 'v10.2.1',
    assets: [
      {
        name: currentPnpmReleaseAssetName(),
        browser_download_url: 'https://example.invalid/pnpm-bin',
        digest: 'sha256:ce86f663be354800f24852675de14c5283a29e983c1be960f6c0159f5f71dc4a',
      },
    ],
  }),
}));

vi.mock('./downloadGitHubReleaseAsset.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  return {
    downloadGitHubReleaseAsset: async (params: Readonly<{ destinationPath: string }>) => {
      await mkdir(dirname(params.destinationPath), { recursive: true });
      await writeFile(params.destinationPath, 'managed-pnpm', 'utf8');
    },
  };
});

function currentPnpmReleaseAssetName(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'pnpm-macos-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'pnpm-macos-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'pnpm-linuxstatic-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'pnpm-linuxstatic-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'pnpm-win-arm64.exe';
  if (process.platform === 'win32' && process.arch === 'x64') return 'pnpm-win-x64.exe';
  throw new Error(`Unsupported pnpm platform: ${process.platform}/${process.arch}`);
}

describe('managedPnpm bootstrap race protection', () => {
  let testHomeDir: string;
  let testEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Create isolated test home directory
    testHomeDir = join(tmpdir(), `happier-pnpm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testHomeDir, { recursive: true });

    testEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: testHomeDir,
      // Ensure no override or system pnpm interferes
      HAPPIER_PNPM_BIN: undefined,
      PATH: '',
    };
  });

  afterEach(async () => {
    if (testHomeDir) {
      await rm(testHomeDir, { recursive: true, force: true });
    }
  });

  it('should handle concurrent first-run bootstrap without corruption', async () => {
    // This test verifies that concurrent calls to ensureManagedPnpmCommand
    // don't corrupt the shared pnpm installation state through proper locking

    // Start multiple concurrent bootstrap attempts
    // These will all try to install pnpm if it doesn't exist
    const concurrentBootstraps = 5;
    const results = await Promise.allSettled(
      Array.from({ length: concurrentBootstraps }, () =>
        ensureManagedPnpmCommand(testEnv)
      )
    );

    // All should either succeed or fail gracefully (no corruption)
    const succeeded = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<string | null>[];
    const failed = results.filter(r => r.status === 'rejected');

    // At least one should succeed (or all should fail gracefully if network/GitHub is unavailable)
    // The key is that we don't get partial/corrupted state

    // The final state should be consistent
    const finalBinPath = managedPnpmBinPath(testEnv);
    const installExists = existsSync(finalBinPath);

    // If any succeeded with a managed path, the installation should exist and be valid
    const managedSuccesses = succeeded.filter(r => r.value === finalBinPath);
    if (managedSuccesses.length > 0) {
      expect(installExists).toBe(true);

      // All successful managed installs should return the same path
      expect(managedSuccesses.every(r => r.value === finalBinPath)).toBe(true);
    }

    // Verify no 'next' directory is left behind (indicates incomplete install)
    const nextDir = join(managedPnpmInstallDir(testEnv), 'next');
    expect(existsSync(nextDir)).toBe(false);

    // Verify no lock file is left behind
    const lockPath = join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock');
    expect(existsSync(lockPath)).toBe(false);
  }, 60000); // Longer timeout for concurrent operations and potential network calls

  it('should return existing installation when already bootstrapped', async () => {
    // Pre-create a valid installation
    const installDir = managedPnpmInstallDir(testEnv);
    const binPath = managedPnpmBinPath(testEnv);
    await mkdir(join(installDir, 'current', 'bin'), { recursive: true });
    await writeFile(binPath, '#!/bin/sh\necho "existing pnpm"', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(binPath, 0o755);
    }

    // Multiple concurrent calls should all return the existing installation
    const results = await Promise.all(
      Array.from({ length: 3 }, () => ensureManagedPnpmCommand(testEnv))
    );

    // All should return the same path
    expect(results.every(r => r === binPath)).toBe(true);
  });

  it('should recover from a stale bootstrap lock left by a crashed bootstrap', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
      if (typeof handler === 'function') {
        handler();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const lockPath = join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock');
      await mkdir(join(managedPnpmInstallDir(testEnv), '.lock'), { recursive: true });
      await writeFile(lockPath, '', 'utf8');
      const staleTime = new Date(Date.now() - 10 * 60 * 1000);
      await utimes(lockPath, staleTime, staleTime);

      const command = await ensureManagedPnpmCommand(testEnv);

      expect(command).toBe(managedPnpmBinPath(testEnv));
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  }, 60000);
});
