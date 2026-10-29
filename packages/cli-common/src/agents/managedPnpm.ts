import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';
import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

import { isPidPresent } from '../process/processLiveness.js';
import { execFileWithDeadline, resolveWindowsCommandOnPath } from '../process/index.js';
import { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
import { removeHappierTempDirAsync } from '../tempDirs/createHappierTempDir.js';
import { resolveVendorInstallTimeoutMs } from './install/vendorRecipeInstall.js';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';
import { promoteManagedCurrentInstall } from './promoteManagedCurrentInstall.js';
import { resolvePnpmReleaseAsset, PNPM_GITHUB_REPO } from './pnpmRelease.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';
import { resolveManagedToolsRoot } from './managedToolsRoot.js';
import type { AgentInstallProgressCallback } from './installProgress.js';

type EnsureManagedPnpmDeps = Readonly<{
  fetchGitHubLatestRelease?: typeof fetchGitHubLatestRelease;
  downloadGitHubReleaseAsset?: typeof downloadGitHubReleaseAsset;
}>;

function resolveManagedPnpmBinaryName(): string {
  return process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
}

const STALE_PNPM_BOOTSTRAP_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const MANAGED_PNPM_BOOTSTRAP_ENV_VAR = 'HAPPIER_MANAGED_PNPM_BOOTSTRAP';

export function managedPnpmInstallDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(resolveManagedToolsRoot(processEnv), 'pnpm');
}

export function managedPnpmBinPath(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(managedPnpmInstallDir(processEnv), 'current', 'bin', resolveManagedPnpmBinaryName());
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExistingManagedOrOverridePnpmCommand(processEnv: NodeJS.ProcessEnv): string | null {
  const override = readPnpmOverride(processEnv);
  if (override) return override;

  const managedPath = managedPnpmBinPath(processEnv);
  return isExecutableFile(managedPath) ? managedPath : null;
}

export function readRawPnpmOverride(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const raw = typeof processEnv.HAPPIER_PNPM_BIN === 'string' ? processEnv.HAPPIER_PNPM_BIN.trim() : '';
  return raw || null;
}

function readPnpmOverride(processEnv: NodeJS.ProcessEnv): string | null {
  const raw = readRawPnpmOverride(processEnv);
  if (!raw) return null;
  return isExecutableFile(raw) ? raw : null;
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
      if (!statSync(candidate).isFile()) continue;
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
async function shouldRecoverStalePnpmBootstrapLock(lockPath: string): Promise<boolean> {
  const lockStats = await stat(lockPath);
  const ageMs = Date.now() - lockStats.mtimeMs;
  const rawContents = await readFile(lockPath, 'utf8').catch(() => '');

  try {
    const parsed = JSON.parse(rawContents) as { pid?: unknown };
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return !isPidPresent(parsed.pid);
    }
  } catch {
    // Fall back to age-based recovery for legacy or malformed locks.
  }

  return ageMs >= STALE_PNPM_BOOTSTRAP_LOCK_MAX_AGE_MS;
}

async function acquirePnpmBootstrapLock(processEnv: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<FileHandle> {
  const lockDir = join(managedPnpmInstallDir(processEnv), '.lock');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, 'bootstrap.lock');

  // Open with exclusive flag; will wait/retry if another process holds the lock
  // Use a simple retry loop with exponential backoff
  const maxRetries = 30;
  const baseDelayMs = 100;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    signal?.throwIfAborted();
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
        await delay(delayMs, undefined, { signal });
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

function shouldBootstrapManagedPnpm(processEnv: NodeJS.ProcessEnv): boolean {
  const raw = typeof processEnv[MANAGED_PNPM_BOOTSTRAP_ENV_VAR] === 'string'
    ? String(processEnv[MANAGED_PNPM_BOOTSTRAP_ENV_VAR]).trim()
    : '';
  return raw !== '0';
}

function isArchiveAssetName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.tar.gz') || lower.endsWith('.tar.xz') || lower.endsWith('.zip');
}

async function extractManagedPnpmArchive(params: Readonly<{
  archivePath: string;
  archiveName: string;
  outputPath: string;
  signal?: AbortSignal;
}>): Promise<void> {
  const binDir = dirname(params.outputPath);
  await mkdir(binDir, { recursive: true });
    await extractArchivePayloadToDirectory({
      archiveName: params.archiveName,
      archivePath: params.archivePath,
      extractDir: binDir,
      // Current pnpm release archives use hard links for duplicate package
      // metadata. The managed executable and its support files are regular
      // entries; ignore link entries rather than weakening the shared archive
      // extractor's fail-closed default.
      tarLinkPolicy: 'skip',
      signal: params.signal,
    });

  const outputStat = await lstat(params.outputPath).catch(() => null);
  if (!outputStat?.isFile()) {
    throw new Error(`Managed pnpm archive did not contain ${params.outputPath}`);
  }
  if (process.platform !== 'win32') {
    await chmod(params.outputPath, 0o755);
  }
}

async function installManagedPnpm(
  processEnv: NodeJS.ProcessEnv,
  deps: EnsureManagedPnpmDeps,
  signal?: AbortSignal,
  onProgress?: AgentInstallProgressCallback,
): Promise<string> {
  // Acquire exclusive lock to prevent concurrent bootstrap races
  const lockHandle = await acquirePnpmBootstrapLock(processEnv, signal);
  try {
    signal?.throwIfAborted();
    // Double-check if installation exists after acquiring lock (another process may have completed it)
    const managedPath = resolveExistingManagedOrOverridePnpmCommand(processEnv);
    if (managedPath) return managedPath;

    const fetchLatestRelease = deps.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease;
    const downloadAsset = deps.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset;

    const release = await fetchLatestRelease({
      signal,
      githubRepo: PNPM_GITHUB_REPO,
      userAgent: 'happier-cli',
      githubToken: processEnv.GITHUB_TOKEN,
    });
    signal?.throwIfAborted();
    const asset = resolvePnpmReleaseAsset(release);
    const scratchDir = await createManagedToolScratchDir({
      installDir: managedPnpmInstallDir(processEnv),
      prefix: 'bootstrap',
    });
    const nextDir = join(managedPnpmInstallDir(processEnv), 'next');
    try {
      const nextBinPath = join(nextDir, 'bin', resolveManagedPnpmBinaryName());
      const downloadPath = join(scratchDir, asset.name);

      await downloadAsset({
        signal,
        onProgress,
        url: asset.url,
        destinationPath: downloadPath,
        digest: asset.digest,
        userAgent: 'happier-cli',
      });

      signal?.throwIfAborted();
      await rm(nextDir, { recursive: true, force: true });
      await mkdir(dirname(nextBinPath), { recursive: true });
      await rm(nextBinPath, { force: true });
      if (isArchiveAssetName(asset.name)) {
        await extractManagedPnpmArchive({
          signal,
          archivePath: downloadPath,
          archiveName: asset.name,
          outputPath: nextBinPath,
        });
      } else {
        await rename(downloadPath, nextBinPath);
      }
      if (process.platform !== 'win32' && !isArchiveAssetName(asset.name)) {
        await chmod(nextBinPath, 0o755);
      }

      signal?.throwIfAborted();
      await promoteManagedCurrentInstall({
        signal,
        installRoot: managedPnpmInstallDir(processEnv),
        candidatePath: nextDir,
      });
      return managedPnpmBinPath(processEnv);
    } finally {
      try {
        await rm(nextDir, { recursive: true, force: true });
      } finally {
        await removeHappierTempDirAsync(scratchDir);
      }
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

/**
 * The pnpm the managed installer uses, without bootstrapping: an override, the existing
 * managed pnpm. `bootstrap` means the next install
 * would first download a managed pnpm.
 */
function selectManagedPnpmCommand(
  processEnv: NodeJS.ProcessEnv,
): Readonly<{ kind: 'command'; command: string | null }> | Readonly<{ kind: 'bootstrap' }> {
  if (readRawPnpmOverride(processEnv)) return { kind: 'command', command: readPnpmOverride(processEnv) };
  const existing = resolveExistingManagedOrOverridePnpmCommand(processEnv);
  if (existing) return { kind: 'command', command: existing };
  if (!shouldBootstrapManagedPnpm(processEnv)) return { kind: 'command', command: null };
  return { kind: 'bootstrap' };
}

export async function ensureManagedPnpmCommand(
  processEnv: NodeJS.ProcessEnv = process.env,
  deps: EnsureManagedPnpmDeps = {},
  options: Readonly<{ signal?: AbortSignal; onProgress?: AgentInstallProgressCallback }> = {},
): Promise<string | null> {
  options.signal?.throwIfAborted();
  const selected = selectManagedPnpmCommand(processEnv);
  if (selected.kind === 'command') return selected.command;

  try {
    return await installManagedPnpm(processEnv, deps, options.signal, options.onProgress);
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
}

export function buildManagedPnpmEnvironment(processEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const homeDir = resolveHappyHomeDirFromEnvironment(processEnv);
  const installDir = managedPnpmInstallDir(processEnv);
  return {
    ...processEnv,
    PNPM_HOME: join(installDir, 'home'),
    // pnpm reads CLI configuration from npm_config_* environment variables;
    // PNPM_STORE_DIR is not a recognized store-dir setting and silently lets
    // the SQLite-backed store fall through to the process user's home.
    npm_config_store_dir: join(installDir, 'store'),
    XDG_CACHE_HOME: processEnv.XDG_CACHE_HOME || join(homeDir, 'cache'),
  };
}

/** pnpm's built-in `minimumReleaseAge` default (minutes) from pnpm 11 on; earlier majors default to 0. */
const PNPM_11_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES = 24 * 60;

/**
 * The release-age rule the managed installer applies to `pnpm add`, in ms: the value the
 * managed pnpm is configured with (`pnpm config get minimumReleaseAge`, which reports rc/env
 * settings), else that pnpm version's built-in default. `null` when there is no existing pnpm
 * to ask (a latest-version check never bootstraps one).
 */
export async function readManagedPnpmMinimumReleaseAgeMs(
  processEnv: NodeJS.ProcessEnv = process.env,
  deps: Readonly<{ execFile?: typeof execFileWithDeadline }> = {},
): Promise<number | null> {
  const selected = selectManagedPnpmCommand(processEnv);
  const pnpm = selected.kind === 'command' ? selected.command : null;
  if (!pnpm) return null;
  const execFile = deps.execFile ?? execFileWithDeadline;
  const env = buildManagedPnpmEnvironment(processEnv);
  const timeout = resolveVendorInstallTimeoutMs(processEnv);
  const ask = async (args: ReadonlyArray<string>): Promise<string | null> => {
    try {
      const { stdout } = await execFile(pnpm, args, {
        env,
        cwd: managedPnpmInstallDir(processEnv),
        encoding: 'utf8',
        windowsHide: true,
        ...(timeout > 0 ? { timeout } : {}),
      });
      return String(stdout).trim();
    } catch {
      return null;
    }
  };

  const configuredValue = await ask(['config', 'get', 'minimumReleaseAge']);
  if (configuredValue !== null && configuredValue !== '') {
    const configured = Number(configuredValue);
    if (Number.isFinite(configured) && configured >= 0) return configured * 60_000;
  }

  const major = Number.parseInt(String(await ask(['--version']) ?? ''), 10);
  if (!Number.isFinite(major)) return null;
  return major >= 11 ? PNPM_11_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES * 60_000 : 0;
}
