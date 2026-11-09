import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, link, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tar from 'tar';
import * as releaseRuntime from '@happier-dev/release-runtime';
import { AgentCliDownloadError } from './downloadGitHubReleaseAsset.js';
import {
  buildManagedPnpmEnvironment,
  ensureManagedPnpmCommand,
  managedPnpmBinPath,
  managedPnpmInstallDir,
} from './managedPnpm.js';

describe('managed pnpm environment', () => {
  it('routes pnpm store state into the Happier-owned writable home', () => {
    const env = buildManagedPnpmEnvironment({ HAPPIER_HOME_DIR: '/fixture/happier' });

    expect(env).toMatchObject({
      PNPM_HOME: '/fixture/happier/tools/pnpm/home',
      npm_config_store_dir: '/fixture/happier/tools/pnpm/store',
      XDG_CACHE_HOME: '/fixture/happier/cache',
    });
  });
});

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: ReadonlyArray<Readonly<{ name: string; contents: string }>>): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const contents = Buffer.from(entry.contents, 'utf8');
    const checksum = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localRecords.push(localHeader, name, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, name);
    localOffset += localHeader.length + name.length + contents.length;
  }

  const centralSize = centralRecords.reduce((size, record) => size + record.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, ...centralRecords, endRecord]);
}

function currentPnpmReleaseAssetName(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'pnpm-darwin-arm64.tar.gz';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'pnpm-darwin-x64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'pnpm-linux-arm64.tar.gz';
  if (process.platform === 'linux' && process.arch === 'x64') return 'pnpm-linux-x64.tar.gz';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'pnpm-win32-arm64.zip';
  if (process.platform === 'win32' && process.arch === 'x64') return 'pnpm-win32-x64.zip';
  throw new Error(`Unsupported pnpm platform: ${process.platform}/${process.arch}`);
}

async function writeCurrentPnpmReleaseAsset(
  destinationPath: string,
  binaryName = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm',
  options: Readonly<{ includeHardLink?: boolean }> = {},
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  if (currentPnpmReleaseAssetName().endsWith('.zip')) {
    await writeFile(destinationPath, createStoredZip([
      { name: binaryName, contents: 'managed-pnpm-extracted' },
      { name: 'dist/index.js', contents: 'managed-pnpm-support' },
    ]));
    return;
  }

  const payloadDir = `${destinationPath}.payload`;
  await mkdir(join(payloadDir, 'dist'), { recursive: true });
  await writeFile(join(payloadDir, binaryName), 'managed-pnpm-extracted', 'utf8');
  await writeFile(join(payloadDir, 'dist', 'index.js'), 'managed-pnpm-support', 'utf8');
  if (options.includeHardLink) {
    await link(
      join(payloadDir, 'dist', 'index.js'),
      join(payloadDir, 'dist', 'linked-package.json'),
    );
  }
  try {
    await tar.c(
      { cwd: payloadDir, file: destinationPath, gzip: true, portable: true },
      [binaryName, 'dist'],
    );
  } finally {
    await rm(payloadDir, { recursive: true, force: true });
  }
}

function createManagedPnpmBoundaryDeps() {
  return {
    downloadGitHubReleaseAsset: async (params: Readonly<{ destinationPath: string }>) => {
      await writeCurrentPnpmReleaseAsset(params.destinationPath);
    },
  };
}

describe('managedPnpm bootstrap race protection', () => {
  let testHomeDir: string;
  let testEnv: NodeJS.ProcessEnv;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(async () => {
    // Fixture-owned tool locks are independent of the runner's workspace build leases.
    vi.stubEnv('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED', '1');
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
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    if (testHomeDir) {
      await rm(testHomeDir, { recursive: true, force: true });
    }
  });

  it('reports a live legacy bootstrap lock wait and preserves the owner when canceled', async () => {
    const lockPath = join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock');
    const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now() - 600_000 });
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, owner);
    const controller = new AbortController();
    const reason = new Error('stop waiting for pnpm');
    const events: string[] = [];
    const watchdog = setTimeout(() => controller.abort(reason), 500);
    try {
      await expect(ensureManagedPnpmCommand(testEnv, {}, {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.t === 'log') {
            events.push(event.line);
            controller.abort(reason);
          }
        },
      })).rejects.toBe(reason);
      expect(events.length).toBeGreaterThan(0);
      expect(await readFile(lockPath, 'utf8')).toBe(owner);
      expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
    } finally {
      clearTimeout(watchdog);
    }
  });

  it('rejects cancellation after download without promoting or falling back', async () => {
    const controller = new AbortController();
    const reason = new Error('bootstrap canceled');
    const deps = createManagedPnpmBoundaryDeps();
    await expect(ensureManagedPnpmCommand(testEnv, {
      ...deps,
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        await writeCurrentPnpmReleaseAsset(destinationPath);
        controller.abort(reason);
      },
    }, { signal: controller.signal })).rejects.toBe(reason);
    expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
    expect(existsSync(join(managedPnpmInstallDir(testEnv), 'next'))).toBe(false);
    expect(existsSync(join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock'))).toBe(false);
  });

  it('bootstraps the pinned pnpm artifact with zero release discovery requests', async () => {
    const discovery = vi.spyOn(releaseRuntime, 'fetchGitHubLatestRelease').mockRejectedValue(new Error('release discovery forbidden'));
    const download = vi.fn(async (params: Readonly<{ destinationPath: string; url: string; digest?: string | null }>) => {
      expect(params.url).toContain('/pnpm/pnpm/releases/download/v12.14.0/');
      expect(params.url.endsWith(`/${currentPnpmReleaseAssetName()}`)).toBe(true);
      expect(params.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      await writeCurrentPnpmReleaseAsset(params.destinationPath);
    });

    await expect(ensureManagedPnpmCommand(testEnv, { downloadGitHubReleaseAsset: download }))
      .resolves.toBe(managedPnpmBinPath(testEnv));
    expect(discovery).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('preserves a typed bootstrap download failure without promoting or falling back', async () => {
    const failure = new AgentCliDownloadError('download-failed', 'fixture asset unavailable');
    await expect(ensureManagedPnpmCommand(testEnv, {
      ...createManagedPnpmBoundaryDeps(),
      downloadGitHubReleaseAsset: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
    expect(existsSync(join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock'))).toBe(false);
  });

  it('should handle concurrent first-run bootstrap without corruption', async () => {
    // This test verifies that concurrent calls to ensureManagedPnpmCommand
    // don't corrupt the shared pnpm installation state through proper locking

    // Start multiple concurrent bootstrap attempts
    // These will all try to install pnpm if it doesn't exist
    const concurrentBootstraps = 5;
    const results = await Promise.allSettled(
      Array.from({ length: concurrentBootstraps }, () =>
        ensureManagedPnpmCommand(testEnv, createManagedPnpmBoundaryDeps())
      )
    );

    const succeeded = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<string | null>[];
    const failed = results.filter(r => r.status === 'rejected');
    expect(failed).toHaveLength(0);
    expect(succeeded).toHaveLength(concurrentBootstraps);

    // The final state should be consistent
    const finalBinPath = managedPnpmBinPath(testEnv);
    const installExists = existsSync(finalBinPath);
    expect(installExists).toBe(true);
    expect(succeeded.map(result => result.value)).toEqual(
      Array.from({ length: concurrentBootstraps }, () => finalBinPath),
    );

    // Verify no 'next' directory is left behind (indicates incomplete install)
    const nextDir = join(managedPnpmInstallDir(testEnv), 'next');
    expect(existsSync(nextDir)).toBe(false);

    // Verify no lock file is left behind
    const lockPath = join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock');
    expect(existsSync(lockPath)).toBe(false);
  }, 60000); // Longer timeout for concurrent operations and potential network calls

  it('should return existing installation when already bootstrapped', async () => {
    const discovery = vi.spyOn(releaseRuntime, 'fetchGitHubLatestRelease').mockRejectedValue(new Error('unexpected discovery'));
    const download = vi.fn(async () => { throw new Error('unexpected download'); });
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
      Array.from({ length: 3 }, () => ensureManagedPnpmCommand(testEnv, { downloadGitHubReleaseAsset: download }))
    );

    // All should return the same path
    expect(results.every(r => r === binPath)).toBe(true);
    expect(discovery).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('reuses a valid explicit pnpm override without network requests', async () => {
    const discovery = vi.spyOn(releaseRuntime, 'fetchGitHubLatestRelease').mockRejectedValue(new Error('unexpected discovery'));
    const download = vi.fn(async () => { throw new Error('unexpected download'); });
    const command = join(testHomeDir, process.platform === 'win32' ? 'override.exe' : 'override');
    await writeFile(command, 'explicit pnpm');
    if (process.platform !== 'win32') await chmod(command, 0o755);
    await expect(ensureManagedPnpmCommand({ ...testEnv, HAPPIER_PNPM_BIN: command }, { downloadGitHubReleaseAsset: download }))
      .resolves.toBe(command);
    expect(discovery).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('should recover from a stale bootstrap lock left by a crashed bootstrap', async () => {
    const lockPath = join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock');
    await mkdir(join(managedPnpmInstallDir(testEnv), '.lock'), { recursive: true });
    await writeFile(lockPath, '', 'utf8');
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, staleTime, staleTime);

    const command = await ensureManagedPnpmCommand(testEnv, createManagedPnpmBoundaryDeps());

    expect(command).toBe(managedPnpmBinPath(testEnv));
    expect(existsSync(lockPath)).toBe(false);
  }, 60000);

  it('extracts the current archive asset and preserves pnpm support files before promoting', async () => {
    const command = await ensureManagedPnpmCommand(testEnv, createManagedPnpmBoundaryDeps());

    expect(command).toBe(managedPnpmBinPath(testEnv));
    await expect(readFile(managedPnpmBinPath(testEnv), 'utf8')).resolves.toBe('managed-pnpm-extracted');
    await expect(readFile(join(dirname(managedPnpmBinPath(testEnv)), 'dist', 'index.js'), 'utf8')).resolves.toBe('managed-pnpm-support');
  });

  it('skips vendor hard-link entries while preserving regular pnpm archive files', async () => {
    if (process.platform === 'win32') return;
    const deps = createManagedPnpmBoundaryDeps();
    const command = await ensureManagedPnpmCommand(testEnv, {
      ...deps,
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        await writeCurrentPnpmReleaseAsset(destinationPath, 'pnpm', { includeHardLink: true });
      },
    });

    expect(command).toBe(managedPnpmBinPath(testEnv));
    await expect(readFile(managedPnpmBinPath(testEnv), 'utf8')).resolves.toBe('managed-pnpm-extracted');
    await expect(readFile(join(dirname(managedPnpmBinPath(testEnv)), 'dist', 'index.js'), 'utf8'))
      .resolves.toBe('managed-pnpm-support');
    await expect(readFile(join(dirname(managedPnpmBinPath(testEnv)), 'dist', 'linked-package.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('extracts Windows zip assets in-process without requiring tar', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    if (process.platform !== 'win32') {
      // This test simulates Windows acquisition on POSIX. Keep secure-temp logic
      // real while representing the genuine Windows system-command boundary.
      vi.stubEnv('USERNAME', 'fixture');
      vi.stubEnv('SystemRoot', 'C:\\Windows');
      const sid = 'S-1-5-21-100-200-300-400';
      vi.spyOn(childProcess, 'spawnSync').mockImplementation((command) => {
        const stdout = String(command).endsWith('whoami.exe') ? `"fixture","${sid}"`
          : JSON.stringify({ ownerSid: sid, protected: true, reparsePoint: false,
            rules: [{ sid, type: 'Allow', inherited: false, rights: 'FullControl' },
              { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' }] });
        return { pid: 0, status: 0, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0),
          output: [null, Buffer.from(stdout), Buffer.alloc(0)] };
      });
      syncBuiltinESMExports();
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const command = await ensureManagedPnpmCommand(testEnv, createManagedPnpmBoundaryDeps());

    expect(command).toBe(managedPnpmBinPath(testEnv));
    await expect(readFile(managedPnpmBinPath(testEnv), 'utf8')).resolves.toBe('managed-pnpm-extracted');
    await expect(readFile(join(dirname(managedPnpmBinPath(testEnv)), 'dist', 'index.js'), 'utf8')).resolves.toBe('managed-pnpm-support');
  });

  it('fails closed and removes staging state when the downloaded archive is corrupt', async () => {
    const deps = createManagedPnpmBoundaryDeps();
    await expect(ensureManagedPnpmCommand(testEnv, {
      ...deps,
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, 'not a valid archive', 'utf8');
      },
    })).rejects.toThrow();
    expect(existsSync(join(managedPnpmInstallDir(testEnv), 'next'))).toBe(false);
    expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
    expect(existsSync(join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock'))).toBe(false);
  });

  it('does not promote an archive with a renamed binary root and removes staging state', async () => {
    const deps = createManagedPnpmBoundaryDeps();
    await expect(ensureManagedPnpmCommand(testEnv, {
      ...deps,
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        await writeCurrentPnpmReleaseAsset(destinationPath, 'renamed-pnpm');
      },
    })).rejects.toThrow();
    expect(existsSync(join(managedPnpmInstallDir(testEnv), 'next'))).toBe(false);
    expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
    expect(existsSync(join(managedPnpmInstallDir(testEnv), '.lock', 'bootstrap.lock'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink in place of the managed pnpm executable', async () => {
    const outsideBinaryPath = join(testHomeDir, 'outside-pnpm');
    await writeFile(outsideBinaryPath, 'outside', 'utf8');
    await chmod(outsideBinaryPath, 0o644);

    const deps = createManagedPnpmBoundaryDeps();
    await expect(ensureManagedPnpmCommand(testEnv, {
      ...deps,
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        const payloadDir = `${destinationPath}.payload`;
        await mkdir(join(payloadDir, 'dist'), { recursive: true });
        await symlink(outsideBinaryPath, join(payloadDir, 'pnpm'));
        await writeFile(join(payloadDir, 'dist', 'index.js'), 'managed-pnpm-support', 'utf8');
        try {
          await tar.c(
            { cwd: payloadDir, file: destinationPath, gzip: true, portable: true },
            ['pnpm', 'dist'],
          );
        } finally {
          await rm(payloadDir, { recursive: true, force: true });
        }
      },
    })).rejects.toThrow();
    expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
    expect((await stat(outsideBinaryPath)).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('does not promote a contained symlink as the managed pnpm executable', async () => {
    const deps = createManagedPnpmBoundaryDeps();
    await expect(ensureManagedPnpmCommand(testEnv, {
      ...deps,
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        const payloadDir = `${destinationPath}.payload`;
        await mkdir(join(payloadDir, 'dist'), { recursive: true });
        await writeFile(join(payloadDir, 'dist', 'index.js'), 'not-the-pnpm-binary', 'utf8');
        await symlink('dist/index.js', join(payloadDir, 'pnpm'));
        try {
          await tar.c(
            { cwd: payloadDir, file: destinationPath, gzip: true, portable: true },
            ['pnpm', 'dist'],
          );
        } finally {
          await rm(payloadDir, { recursive: true, force: true });
        }
      },
    })).rejects.toThrow();
    expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
  });

  it('does not bootstrap managed pnpm when HAPPIER_MANAGED_PNPM_BOOTSTRAP is disabled', async () => {
    const pathDir = join(testHomeDir, 'path');
    await mkdir(pathDir);
    const pathPnpm = join(pathDir, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm');
    await writeFile(pathPnpm, 'path pnpm');
    await chmod(pathPnpm, 0o755);
    testEnv = {
      ...testEnv,
      PATH: pathDir,
      HAPPIER_MANAGED_PNPM_BOOTSTRAP: '0',
    };

    const command = await ensureManagedPnpmCommand(testEnv);
    expect(command).toBeNull();

    expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
  });

  it('preserves bootstrap failure even when pnpm exists on PATH', async () => {
    const pathDir = join(testHomeDir, 'path');
    await mkdir(pathDir);
    const pathPnpm = join(pathDir, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm');
    await writeFile(pathPnpm, 'path pnpm');
    await chmod(pathPnpm, 0o755);
    testEnv.PATH = pathDir;

    const failure = new Error('fixture service unavailable');
    await expect(ensureManagedPnpmCommand(testEnv, {
      downloadGitHubReleaseAsset: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(existsSync(managedPnpmBinPath(testEnv))).toBe(false);
  });
});
