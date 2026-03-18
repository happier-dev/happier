import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';

import { resolveWindowsCommandOnPath } from '../process/index.js';
import { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';
import { resolvePnpmReleaseAsset, PNPM_GITHUB_REPO } from './pnpmRelease.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

type EnsureManagedPnpmDeps = Readonly<{
  fetchGitHubLatestRelease?: typeof fetchGitHubLatestRelease;
  downloadGitHubReleaseAsset?: typeof downloadGitHubReleaseAsset;
}>;

function resolveManagedPnpmBinaryName(): string {
  return process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
}

const STALE_PNPM_BOOTSTRAP_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

export function managedPnpmInstallDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHappyHomeDirFromEnvironment(processEnv), 'tools', 'pnpm');
}

export function managedPnpmBinPath(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(managedPnpmInstallDir(processEnv), 'current', 'bin', resolveManagedPnpmBinaryName());
}

function resolveExistingManagedOrOverridePnpmCommand(processEnv: NodeJS.ProcessEnv): string | null {
  const override = readPnpmOverride(processEnv);
  if (override) return override;

  const managedPath = managedPnpmBinPath(processEnv);
  try {
    accessSync(managedPath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return managedPath;
  } catch {
    return null;
  }
}

export function readRawPnpmOverride(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const raw = typeof processEnv.HAPPIER_PNPM_BIN === 'string' ? processEnv.HAPPIER_PNPM_BIN.trim() : '';
  return raw || null;
}

function readPnpmOverride(processEnv: NodeJS.ProcessEnv): string | null {
  const raw = readRawPnpmOverride(processEnv);
  if (!raw) return null;
  try {
    accessSync(raw, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return raw;
  } catch {
    return null;
  }
}

function resolveCommandOnPath(command: string, processEnv: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath(command, processEnv) ?? null;
  }

  const pathDirs = String(processEnv.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, command);
    if (!existsSync(candidate)) continue;
    // On Unix, verify the file is executable
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // File exists but is not executable; continue searching
      continue;
    }
  }
  return null;
}

/**
 * Acquire an exclusive lock for pnpm bootstrap to prevent concurrent installs from corrupting shared state.
 * Returns a FileHandle that must be closed to release the lock.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function shouldRecoverStalePnpmBootstrapLock(lockPath: string): Promise<boolean> {
  const lockStats = await stat(lockPath);
  const ageMs = Date.now() - lockStats.mtimeMs;
  const rawContents = await readFile(lockPath, 'utf8').catch(() => '');

  try {
    const parsed = JSON.parse(rawContents) as { pid?: unknown };
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return !isProcessAlive(parsed.pid);
    }
  } catch {
    // Fall back to age-based recovery for legacy or malformed locks.
  }

  return ageMs >= STALE_PNPM_BOOTSTRAP_LOCK_MAX_AGE_MS;
}

async function acquirePnpmBootstrapLock(processEnv: NodeJS.ProcessEnv): Promise<FileHandle> {
  const lockDir = join(managedPnpmInstallDir(processEnv), '.lock');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, 'bootstrap.lock');

  // Open with exclusive flag; will wait/retry if another process holds the lock
  // Use a simple retry loop with exponential backoff
  const maxRetries = 30;
  const baseDelayMs = 100;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      // Try to open exclusively; on Unix this uses O_EXCL, on Windows uses exclusive share mode
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
      return handle;
    } catch (err) {
      // EEXIST means lock is held; retry with backoff
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && attempt < maxRetries - 1) {
        if (await shouldRecoverStalePnpmBootstrapLock(lockPath).catch(() => false)) {
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
        const delayMs = baseDelayMs * Math.pow(1.5, attempt);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to acquire pnpm bootstrap lock after retries');
}

export function resolveExistingPnpmCommand(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const managedOrOverride = resolveExistingManagedOrOverridePnpmCommand(processEnv);
  if (managedOrOverride) return managedOrOverride;

  return resolveCommandOnPath('pnpm', processEnv);
}

async function installManagedPnpm(
  processEnv: NodeJS.ProcessEnv,
  deps: EnsureManagedPnpmDeps,
): Promise<string> {
  // Acquire exclusive lock to prevent concurrent bootstrap races
  const lockHandle = await acquirePnpmBootstrapLock(processEnv);
  try {
    // Double-check if installation exists after acquiring lock (another process may have completed it)
    const managedPath = resolveExistingManagedOrOverridePnpmCommand(processEnv);
    if (managedPath) return managedPath;

    const fetchLatestRelease = deps.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease;
    const downloadAsset = deps.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset;

    const release = await fetchLatestRelease({
      githubRepo: PNPM_GITHUB_REPO,
      userAgent: 'happier-cli',
      githubToken: processEnv.GITHUB_TOKEN,
    });
    const asset = resolvePnpmReleaseAsset(release);
    const scratchDir = await createManagedToolScratchDir({
      installDir: managedPnpmInstallDir(processEnv),
      prefix: 'bootstrap',
    });
    try {
      const nextDir = join(managedPnpmInstallDir(processEnv), 'next');
      const nextBinPath = join(nextDir, 'bin', resolveManagedPnpmBinaryName());
      const downloadPath = join(scratchDir, asset.name);

      await downloadAsset({
        url: asset.url,
        destinationPath: downloadPath,
        digest: asset.digest,
        userAgent: 'happier-cli',
      });

      await rm(nextDir, { recursive: true, force: true });
      await mkdir(dirname(nextBinPath), { recursive: true });
      await rm(nextBinPath, { force: true });
      await rename(downloadPath, nextBinPath);
      if (process.platform !== 'win32') {
        await chmod(nextBinPath, 0o755);
      }

      await rm(join(managedPnpmInstallDir(processEnv), 'current'), { recursive: true, force: true });
      await mkdir(managedPnpmInstallDir(processEnv), { recursive: true });
      await rename(nextDir, join(managedPnpmInstallDir(processEnv), 'current'));
      return managedPnpmBinPath(processEnv);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  } finally {
    // Release lock
    await lockHandle.close();
    // Clean up lock file (best effort; ignore errors)
    try {
      const lockPath = join(managedPnpmInstallDir(processEnv), '.lock', 'bootstrap.lock');
      await rm(lockPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

export async function ensureManagedPnpmCommand(
  processEnv: NodeJS.ProcessEnv = process.env,
  deps: EnsureManagedPnpmDeps = {},
): Promise<string | null> {
  const rawOverride = readRawPnpmOverride(processEnv);
  if (rawOverride) {
    return readPnpmOverride(processEnv);
  }

  const existing = resolveExistingManagedOrOverridePnpmCommand(processEnv);
  if (existing) return existing;

  try {
    return await installManagedPnpm(processEnv, deps);
  } catch {
    return resolveCommandOnPath('pnpm', processEnv);
  }
}

export function buildManagedPnpmEnvironment(processEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const homeDir = resolveHappyHomeDirFromEnvironment(processEnv);
  return {
    ...processEnv,
    PNPM_HOME: join(homeDir, 'tools', 'pnpm', 'home'),
    PNPM_STORE_DIR: join(homeDir, 'tools', 'pnpm', 'store'),
    XDG_CACHE_HOME: processEnv.XDG_CACHE_HOME || join(homeDir, 'cache'),
  };
}
