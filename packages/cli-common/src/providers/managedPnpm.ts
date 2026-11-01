import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';
import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';

import { withWorkspaceBundleLock } from '../../workspaceBundleLock.mjs';
import { resolveExecutableCommand, runCommandCapture } from '../process/index.js';
import type { ManagedToolBootstrapOptions } from './managedToolBootstrap.js';
import { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
import { resolveProviderInstallCommandTimeoutMs } from './installCommandTimeout.js';
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
const MANAGED_PNPM_BOOTSTRAP_ENV_VAR = 'HAPPIER_MANAGED_PNPM_BOOTSTRAP';

export function managedPnpmInstallDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHappyHomeDirFromEnvironment(processEnv), 'tools', 'pnpm');
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

export function resolveExistingPnpmCommand(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const managedOrOverride = resolveExistingManagedOrOverridePnpmCommand(processEnv);
  if (managedOrOverride) return managedOrOverride;

  return resolveExecutableCommand('pnpm', { env: processEnv });
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
    signal: params.signal,
  });

  const outputStat = await stat(params.outputPath).catch(() => null);
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
  options: ManagedToolBootstrapOptions,
): Promise<string> {
  return await withWorkspaceBundleLock(async () => {
    // Double-check if installation exists after acquiring lock (another process may have completed it)
    const managedPath = resolveExistingManagedOrOverridePnpmCommand(processEnv);
    if (managedPath) return managedPath;

    const fetchLatestRelease = deps.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease;
    const downloadAsset = deps.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset;

    options.onProgress?.({ t: 'progress', phase: 'fetching-release' });
    const release = await fetchLatestRelease({
      githubRepo: PNPM_GITHUB_REPO,
      userAgent: 'happier-cli',
      githubToken: processEnv.GITHUB_TOKEN,
      signal: options.signal,
    });
    const asset = resolvePnpmReleaseAsset(release);
    const scratchDir = await createManagedToolScratchDir({
      installDir: managedPnpmInstallDir(processEnv),
      prefix: 'bootstrap',
    });
    const nextDir = join(managedPnpmInstallDir(processEnv), 'next');
    try {
      const nextBinPath = join(nextDir, 'bin', resolveManagedPnpmBinaryName());
      const downloadPath = join(scratchDir, asset.name);

      options.signal?.throwIfAborted();
      options.onProgress?.({ t: 'progress', phase: 'downloading', bytesDone: 0 });
      await downloadAsset({
        url: asset.url,
        destinationPath: downloadPath,
        digest: asset.digest,
        userAgent: 'happier-cli',
        signal: options.signal,
        onProgress: (event) => options.onProgress?.({ t: 'progress', phase: 'downloading', ...event }),
      });

      options.signal?.throwIfAborted();
      options.onProgress?.({ t: 'progress', phase: 'installing' });
      await rm(nextDir, { recursive: true, force: true });
      await mkdir(dirname(nextBinPath), { recursive: true });
      await rm(nextBinPath, { force: true });
      if (isArchiveAssetName(asset.name)) {
        await extractManagedPnpmArchive({
          archivePath: downloadPath,
          archiveName: asset.name,
          outputPath: nextBinPath,
          signal: options.signal,
        });
      } else {
        await rename(downloadPath, nextBinPath);
      }
      if (process.platform !== 'win32' && !isArchiveAssetName(asset.name)) {
        await chmod(nextBinPath, 0o755);
      }

      options.signal?.throwIfAborted();
      await rm(join(managedPnpmInstallDir(processEnv), 'current'), { recursive: true, force: true });
      await mkdir(managedPnpmInstallDir(processEnv), { recursive: true });
      await rename(nextDir, join(managedPnpmInstallDir(processEnv), 'current'));
      return managedPnpmBinPath(processEnv);
    } finally {
      await rm(nextDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, {
    lockPath: join(managedPnpmInstallDir(processEnv), '.lock', 'bootstrap.lock'),
    timeoutMs: null,
    staleAfterMs: STALE_PNPM_BOOTSTRAP_LOCK_MAX_AGE_MS,
    signal: options.signal,
    errorLabel: 'managed pnpm bootstrap lock',
    onWait: () => options.onProgress?.({ t: 'progress', phase: 'waiting-for-lock' }),
  });
}

/**
 * The pnpm the managed installer uses, without bootstrapping: an override, the existing
 * managed pnpm, or (bootstrap disabled) pnpm on PATH. `bootstrap` means the next install
 * would first download a managed pnpm.
 */
function selectManagedPnpmCommand(
  processEnv: NodeJS.ProcessEnv,
): Readonly<{ kind: 'command'; command: string | null }> | Readonly<{ kind: 'bootstrap' }> {
  if (readRawPnpmOverride(processEnv)) return { kind: 'command', command: readPnpmOverride(processEnv) };
  const existing = resolveExistingManagedOrOverridePnpmCommand(processEnv);
  if (existing) return { kind: 'command', command: existing };
  if (!shouldBootstrapManagedPnpm(processEnv)) return { kind: 'command', command: resolveExecutableCommand('pnpm', { env: processEnv }) };
  return { kind: 'bootstrap' };
}

export async function ensureManagedPnpmCommand(
  processEnv: NodeJS.ProcessEnv = process.env,
  deps: EnsureManagedPnpmDeps = {},
  options: ManagedToolBootstrapOptions = {},
): Promise<string | null> {
  options.signal?.throwIfAborted();
  const selected = selectManagedPnpmCommand(processEnv);
  if (selected.kind === 'command') return selected.command;

  try {
    return await installManagedPnpm(processEnv, deps, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
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
  deps: Readonly<{ runCommand?: typeof runCommandCapture }> = {},
): Promise<number | null> {
  const selected = selectManagedPnpmCommand(processEnv);
  const pnpm = selected.kind === 'command' ? selected.command : null;
  if (!pnpm) return null;
  const runCommand = deps.runCommand ?? runCommandCapture;
  const env = buildManagedPnpmEnvironment(processEnv);
  const timeoutMs = resolveProviderInstallCommandTimeoutMs(processEnv);
  const ask = async (args: ReadonlyArray<string>): Promise<string | null> => {
    const result = await runCommand({ cmd: pnpm, args, env, cwd: managedPnpmInstallDir(processEnv), timeoutMs });
    return result.kind === 'exited' && result.status === 0 ? result.stdout.trim() : null;
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
