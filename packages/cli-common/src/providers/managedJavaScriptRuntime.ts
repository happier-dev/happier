import { accessSync, constants as fsConstants } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { withWorkspaceBundleLock } from '../../workspaceBundleLock.mjs';
import type { ManagedToolBootstrapOptions } from './managedToolBootstrap.js';

import { resolveWindowsCommandOnPath, resolveWindowsCommandPath } from '../process/index.js';

import { expandHomeDirPath } from '../path/expandHomeDirPath.js';
import { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';
import { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset.js';
import { fetchNodeRuntimeReleaseAsset } from './nodeRelease.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

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
    if (process.platform === 'win32') {
      const normalizedOverride =
        (override.includes('/') || override.includes('\\') || override.includes(':'))
          ? resolveWindowsCommandPath(override, processEnv)
          : resolveWindowsCommandOnPath(override, processEnv);
      if (normalizedOverride) return normalizedOverride;
    }
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
    .map((value) => expandHomeDirPath(String(value ?? '').trim(), processEnv))
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
    return resolveExistingManagedJavaScriptRuntimeCommand(processEnv);
  }
  if (
    isRunnableExecutablePath(currentExecPath)
    && (isDirectNodeExecutablePath(currentExecPath) || isManagedJavaScriptRuntimeWrapperPath(currentExecPath))
  ) {
    return currentExecPath;
  }
  if (isDirectBunExecutablePath(currentExecPath)) return currentExecPath;
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

const JS_RUNTIME_BOOTSTRAP_LOCK_STALE_MS = 5 * 60 * 1000;

export async function ensureManagedJavaScriptRuntimeCommand(
  processEnv: NodeJS.ProcessEnv = process.env,
  deps: EnsureManagedJavaScriptRuntimeDeps = {},
  options: ManagedToolBootstrapOptions = {},
): Promise<string | null> {
  options.signal?.throwIfAborted();
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

  try {
    return await withWorkspaceBundleLock(async () => {
      const managedAfterLock = resolveExistingManagedJavaScriptRuntimeCommand(processEnv);
      if (managedAfterLock) {
        return managedAfterLock;
      }

      options.onProgress?.({ t: 'progress', phase: 'fetching-release' });
      const release = await fetchNodeRelease({ processEnv, signal: options.signal });
      const scratchDir = await createManagedToolScratchDir({
        installDir,
        prefix: 'bootstrap',
      });
      try {
        const archivePath = join(scratchDir, release.name);
        const extractDir = join(scratchDir, 'extract');
        const nextRuntimeDir = join(nextDir, 'runtime');
        const nextNodeBinaryPath = resolveNextManagedNodeBinaryPath(processEnv, release.binaryRelativePath);

        options.signal?.throwIfAborted();
        options.onProgress?.({ t: 'progress', phase: 'downloading', bytesDone: 0 });
        await downloadAsset({
          url: release.url,
          destinationPath: archivePath,
          digest: release.digest,
          userAgent: 'happier-cli',
          signal: options.signal,
          onProgress: (event) => options.onProgress?.({ t: 'progress', phase: 'downloading', ...event }),
        });

        options.signal?.throwIfAborted();
        options.onProgress?.({ t: 'progress', phase: 'installing' });
        await rm(nextDir, { recursive: true, force: true });
        await extractAsset({
          archivePath,
          archiveName: release.name,
          extractDir,
          outputPath: nextRuntimeDir,
          skipTarLinks: true,
          signal: options.signal,
        });

        await mkdir(dirname(nextNodeBinaryPath), { recursive: true });
        accessSync(nextNodeBinaryPath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        await writeManagedJavaScriptRuntimeWrapper({
          outputPath: nextBinPath,
          runtimeBinaryPath: process.platform === 'win32' ? '%~dp0..\\runtime\\node.exe' : '$(dirname "$0")/../runtime/bin/node',
        });

        options.signal?.throwIfAborted();
        await rm(join(installDir, 'current'), { recursive: true, force: true });
        await mkdir(installDir, { recursive: true });
        await rename(nextDir, join(installDir, 'current'));
        return managedJavaScriptRuntimeBinPath(processEnv);
      } finally {
        await rm(nextDir, { recursive: true, force: true });
        await rm(scratchDir, { recursive: true, force: true });
      }
    }, {
      lockPath: join(installDir, '.lock', 'bootstrap.lock'),
      timeoutMs: null,
      staleAfterMs: JS_RUNTIME_BOOTSTRAP_LOCK_STALE_MS,
      signal: options.signal,
      errorLabel: 'managed JavaScript runtime bootstrap lock',
      onWait: () => options.onProgress?.({ t: 'progress', phase: 'waiting-for-lock' }),
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new Error('Managed JavaScript runtime is unavailable: bootstrap failed', { cause: error });
  }
}
