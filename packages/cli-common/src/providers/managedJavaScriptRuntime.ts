import { accessSync, constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';

import { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';
import { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset.js';
import { fetchNodeRuntimeReleaseAsset } from './nodeRelease.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';
import { resolveWindowsCommandOnPath } from '../process/index.js';

function resolveManagedJavaScriptRuntimeBinaryName(): string {
  return process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime';
}

export function managedJavaScriptRuntimeInstallDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHappyHomeDirFromEnvironment(processEnv), 'tools', 'js-runtime');
}

export function managedJavaScriptRuntimeBinPath(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(managedJavaScriptRuntimeInstallDir(processEnv), 'current', 'bin', resolveManagedJavaScriptRuntimeBinaryName());
}

function resolveNextManagedJavaScriptRuntimeBinPath(processEnv: NodeJS.ProcessEnv): string {
  return join(managedJavaScriptRuntimeInstallDir(processEnv), 'next', 'bin', resolveManagedJavaScriptRuntimeBinaryName());
}

function resolveManagedNodeBinaryPath(processEnv: NodeJS.ProcessEnv): string {
  return process.platform === 'win32'
    ? join(managedJavaScriptRuntimeInstallDir(processEnv), 'current', 'runtime', 'node.exe')
    : join(managedJavaScriptRuntimeInstallDir(processEnv), 'current', 'runtime', 'bin', 'node');
}

export function resolveJavaScriptRuntimePathEntries(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  runtimeCommand?: string | null;
}> = {}): ReadonlyArray<string> {
  const processEnv = params.processEnv ?? process.env;
  const runtimeCommand =
    typeof params.runtimeCommand === 'string' && params.runtimeCommand.trim().length > 0
      ? params.runtimeCommand.trim()
      : resolveJavaScriptRuntimeCommand({ isBunRuntime: isDirectBunExecutablePath(process.execPath), processEnv });
  if (!runtimeCommand) {
    return [];
  }

  const normalizedBase = basename(runtimeCommand).trim().toLowerCase();
  if (normalizedBase === 'node' || normalizedBase === 'node.exe') {
    return [dirname(runtimeCommand)];
  }

  const managedWrapperPath = managedJavaScriptRuntimeBinPath(processEnv);
  if (runtimeCommand === managedWrapperPath) {
    return [dirname(resolveManagedNodeBinaryPath(processEnv))];
  }

  if (normalizedBase === 'happier-js-runtime' || normalizedBase === 'happier-js-runtime.cmd') {
    const siblingRuntimeDir = process.platform === 'win32'
      ? join(dirname(runtimeCommand), '..', 'runtime')
      : join(dirname(runtimeCommand), '..', 'runtime', 'bin');
    try {
      accessSync(
        process.platform === 'win32' ? join(siblingRuntimeDir, 'node.exe') : join(siblingRuntimeDir, 'node'),
        process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
      );
      return [siblingRuntimeDir];
    } catch {
      return [dirname(runtimeCommand)];
    }
  }

  return [dirname(runtimeCommand)];
}

function resolveNextManagedNodeBinaryPath(processEnv: NodeJS.ProcessEnv, binaryRelativePath: string): string {
  return join(managedJavaScriptRuntimeInstallDir(processEnv), 'next', 'runtime', binaryRelativePath);
}

export function resolveExplicitJavaScriptRuntimeCommand(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const override = readExplicitJavaScriptRuntimeCommand(processEnv);
  if (override) {
    try {
      accessSync(override, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return override;
    } catch {
      return null;
    }
  }

  return null;
}

export function readExplicitJavaScriptRuntimeCommand(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const override = [
    processEnv.HAPPIER_JS_RUNTIME_PATH,
    processEnv.HAPPIER_MANAGED_NODE_BIN,
    processEnv.HAPPIER_NODE_PATH,
  ]
    .map((value) => String(value ?? '').trim())
    .find((value) => value.length > 0);
  return override ?? null;
}

export function resolveExistingManagedJavaScriptRuntimeCommand(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const rawOverride = readExplicitJavaScriptRuntimeCommand(processEnv);
  const override = resolveExplicitJavaScriptRuntimeCommand(processEnv);
  if (rawOverride && !override) return null;
  if (override) return override;

  const managedPath = managedJavaScriptRuntimeBinPath(processEnv);
  try {
    accessSync(managedPath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    accessSync(resolveManagedNodeBinaryPath(processEnv), process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return managedPath;
  } catch {
    return null;
  }
}

function isDirectBunExecutablePath(execPath: string): boolean {
  const normalized = basename(execPath).trim().toLowerCase();
  return normalized === 'bun' || normalized === 'bun.exe';
}

function isDirectNodeExecutablePath(execPath: string): boolean {
  const normalized = basename(execPath).trim().toLowerCase();
  return normalized === 'node' || normalized === 'node.exe';
}

function isManagedJavaScriptRuntimeWrapperPath(execPath: string): boolean {
  const normalized = basename(execPath).trim().toLowerCase();
  return normalized === 'happier-js-runtime' || normalized === 'happier-js-runtime.cmd';
}

function isRunnableExecutablePath(pathLike: string | null | undefined): boolean {
  const candidate = String(pathLike ?? '').trim();
  if (!candidate) return false;
  try {
    accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSystemNodeOnPath(processEnv: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath('node', processEnv) ?? null;
  }

  const pathDirs = String(processEnv.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);

  for (const dir of pathDirs) {
    const candidate = join(dir, 'node');
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveJavaScriptRuntimeCommand(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
}>): string | null {
  const processEnv = params.processEnv ?? process.env;
  const currentExecPath =
    typeof params.currentExecPath === 'string' && params.currentExecPath.trim().length > 0
      ? params.currentExecPath.trim()
      : process.execPath;
  const rawOverride = readExplicitJavaScriptRuntimeCommand(processEnv);
  const override = resolveExplicitJavaScriptRuntimeCommand(processEnv);

  if (rawOverride && !override) return null;
  if (override) return override;
  if (!params.isBunRuntime) {
    if (
      isRunnableExecutablePath(currentExecPath)
      && (isDirectNodeExecutablePath(currentExecPath) || isManagedJavaScriptRuntimeWrapperPath(currentExecPath))
    ) {
      return currentExecPath;
    }
    return resolveSystemNodeOnPath(processEnv) ?? resolveExistingManagedJavaScriptRuntimeCommand(processEnv);
  }
  if (isDirectBunExecutablePath(currentExecPath)) return currentExecPath;
  const systemNode = resolveSystemNodeOnPath(processEnv);
  if (systemNode) return systemNode;
  return resolveExistingManagedJavaScriptRuntimeCommand(processEnv);
}

async function writeManagedJavaScriptRuntimeWrapper(params: Readonly<{
  outputPath: string;
  runtimeBinaryPath: string;
}>): Promise<void> {
  await mkdir(dirname(params.outputPath), { recursive: true });

  if (process.platform === 'win32') {
    await writeFile(
      params.outputPath,
      `@echo off\r\n"${params.runtimeBinaryPath}" %*\r\n`,
      'utf8',
    );
    return;
  }

  await writeFile(
    params.outputPath,
    `#!/bin/sh\nexec "${params.runtimeBinaryPath}" "$@"\n`,
    'utf8',
  );
  await chmod(params.outputPath, 0o755);
}

type EnsureManagedJavaScriptRuntimeDeps = Readonly<{
  fetchNodeRuntimeReleaseAsset?: typeof fetchNodeRuntimeReleaseAsset;
  downloadGitHubReleaseAsset?: typeof downloadGitHubReleaseAsset;
  extractGitHubReleaseAsset?: typeof extractGitHubReleaseAsset;
}>;

const JS_RUNTIME_BOOTSTRAP_LOCK_MAX_RETRIES = 40;
const JS_RUNTIME_BOOTSTRAP_LOCK_BASE_DELAY_MS = 25;
const JS_RUNTIME_BOOTSTRAP_LOCK_STALE_MS = 5 * 60 * 1000;

function resolveManagedJavaScriptRuntimeBootstrapLockPath(processEnv: NodeJS.ProcessEnv): string {
  return join(managedJavaScriptRuntimeInstallDir(processEnv), '.lock', 'bootstrap.lock');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireManagedJavaScriptRuntimeBootstrapLock(
  processEnv: NodeJS.ProcessEnv,
): Promise<FileHandle> {
  const lockPath = resolveManagedJavaScriptRuntimeBootstrapLockPath(processEnv);
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < JS_RUNTIME_BOOTSTRAP_LOCK_MAX_RETRIES; attempt += 1) {
    try {
      return await open(lockPath, 'wx');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }

      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > JS_RUNTIME_BOOTSTRAP_LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        const statErr = statError as NodeJS.ErrnoException;
        if (statErr.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }

      if (attempt === JS_RUNTIME_BOOTSTRAP_LOCK_MAX_RETRIES - 1) {
        throw new Error('Failed to acquire managed JavaScript runtime bootstrap lock');
      }

      await delay(Math.round(JS_RUNTIME_BOOTSTRAP_LOCK_BASE_DELAY_MS * Math.pow(1.5, attempt)));
    }
  }

  throw new Error('Failed to acquire managed JavaScript runtime bootstrap lock');
}

export async function ensureManagedJavaScriptRuntimeCommand(
  processEnv: NodeJS.ProcessEnv = process.env,
  deps: EnsureManagedJavaScriptRuntimeDeps = {},
): Promise<string | null> {
  const rawOverride = readExplicitJavaScriptRuntimeCommand(processEnv);
  if (rawOverride) {
    return resolveExplicitJavaScriptRuntimeCommand(processEnv);
  }

  const existing = resolveExistingManagedJavaScriptRuntimeCommand(processEnv);
  if (existing) return existing;

  const installDir = managedJavaScriptRuntimeInstallDir(processEnv);
  const nextDir = join(installDir, 'next');
  const nextBinPath = resolveNextManagedJavaScriptRuntimeBinPath(processEnv);
  const fetchNodeRelease = deps.fetchNodeRuntimeReleaseAsset ?? fetchNodeRuntimeReleaseAsset;
  const downloadAsset = deps.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset;
  const extractAsset = deps.extractGitHubReleaseAsset ?? extractGitHubReleaseAsset;
  let lockHandle: FileHandle | null = null;

  try {
    lockHandle = await acquireManagedJavaScriptRuntimeBootstrapLock(processEnv);
    const managedAfterLock = resolveExistingManagedJavaScriptRuntimeCommand(processEnv);
    if (managedAfterLock) {
      return managedAfterLock;
    }

    const release = await fetchNodeRelease({ processEnv });
    const scratchDir = await createManagedToolScratchDir({
      installDir,
      prefix: 'bootstrap',
    });
    try {
      const archivePath = join(scratchDir, release.name);
      const extractDir = join(scratchDir, 'extract');
      const nextRuntimeDir = join(nextDir, 'runtime');
      const nextNodeBinaryPath = resolveNextManagedNodeBinaryPath(processEnv, release.binaryRelativePath);

      await downloadAsset({
        url: release.url,
        destinationPath: archivePath,
        digest: release.digest,
        userAgent: 'happier-cli',
      });

      await rm(nextDir, { recursive: true, force: true });
      await extractAsset({
        archivePath,
        archiveName: release.name,
        extractDir,
        outputPath: nextRuntimeDir,
      });

      await mkdir(dirname(nextNodeBinaryPath), { recursive: true });
      accessSync(nextNodeBinaryPath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      await writeManagedJavaScriptRuntimeWrapper({
        outputPath: nextBinPath,
        runtimeBinaryPath: process.platform === 'win32' ? '%~dp0..\\runtime\\node.exe' : '$(dirname "$0")/../runtime/bin/node',
      });

      await rm(join(installDir, 'current'), { recursive: true, force: true });
      await mkdir(installDir, { recursive: true });
      await rename(nextDir, join(installDir, 'current'));
      return managedJavaScriptRuntimeBinPath(processEnv);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  } catch {
    return null;
  } finally {
    if (lockHandle) {
      try {
        await lockHandle.close();
      } finally {
        try {
          await rm(resolveManagedJavaScriptRuntimeBootstrapLockPath(processEnv), { force: true });
        } catch {
          // Ignore best-effort lock cleanup failures after bootstrap completes.
        }
      }
    }
  }
}
