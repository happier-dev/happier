import { accessSync, constants as fsConstants } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { withWorkspaceBundleLock } from '../../workspaceBundleLock.mjs';
import { expandHomeDirPath } from '../path/expandHomeDirPath.js';
import { execFileWithDeadline, resolveExecutableCommand, resolveWindowsCommandInvocation } from '../process/index.js';
import { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
import { removeHappierTempDirAsync } from '../tempDirs/createHappierTempDir.js';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';
import { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset.js';
import { fetchNodeRuntimeReleaseAsset } from './nodeRelease.js';
import { promoteManagedCurrentInstall } from './promoteManagedCurrentInstall.js';
import { resolveManagedToolsRoot } from './managedToolsRoot.js';
import type { AgentInstallProgressCallback } from './installProgress.js';

function resolveManagedJavaScriptRuntimeBinaryName(): string {
  return process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime';
}

export function managedJavaScriptRuntimeInstallDir(processEnv: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(resolveManagedToolsRoot(processEnv), 'js-runtime');
}

export function managedJavaScriptRuntimeBinPath(processEnv: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(managedJavaScriptRuntimeInstallDir(processEnv), 'current', 'bin', resolveManagedJavaScriptRuntimeBinaryName());
}

function resolveNextManagedJavaScriptRuntimeBinPath(processEnv: NodeJS.ProcessEnv): string {
  return join(managedJavaScriptRuntimeInstallDir(processEnv), 'next', 'bin', resolveManagedJavaScriptRuntimeBinaryName());
}

function resolveManagedNodeBinaryPath(processEnv: Readonly<Record<string, string | undefined>>): string {
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

export function resolveExplicitJavaScriptRuntimeCommand(
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
  cwd?: string,
): string | null {
  const override = readExplicitJavaScriptRuntimeCommand(processEnv);
  return override ? resolveExecutableCommand(override, { env: processEnv, cwd }) : null;
}

export function readExplicitJavaScriptRuntimeCommand(processEnv: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const override = [
    processEnv.HAPPIER_JS_RUNTIME_PATH,
    processEnv.HAPPIER_MANAGED_NODE_BIN,
    processEnv.HAPPIER_NODE_PATH,
  ]
    .map((value) => expandHomeDirPath(String(value ?? '').trim(), processEnv))
    .find((value) => value.length > 0);
  return override ?? null;
}

export function resolveExistingManagedJavaScriptRuntimeCommand(
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
  cwd?: string,
): string | null {
  const rawOverride = readExplicitJavaScriptRuntimeCommand(processEnv);
  const override = resolveExplicitJavaScriptRuntimeCommand(processEnv, cwd);
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

function resolveManagedJavaScriptRuntimeBinaryFromWrapper(
  wrapperPath: string,
): string | null {
  const runtimeBinaryPath = process.platform === 'win32'
    ? join(dirname(wrapperPath), '..', 'runtime', 'node.exe')
    : join(dirname(wrapperPath), '..', 'runtime', 'bin', 'node');
  return isRunnableExecutablePath(runtimeBinaryPath) ? runtimeBinaryPath : null;
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
  processEnv?: Readonly<Record<string, string | undefined>>;
  currentExecPath?: string | null;
  cwd?: string;
}>): string | null {
  const processEnv = params.processEnv ?? process.env;
  const currentExecPath =
    typeof params.currentExecPath === 'string' && params.currentExecPath.trim().length > 0
      ? params.currentExecPath.trim()
      : process.execPath;
  const rawOverride = readExplicitJavaScriptRuntimeCommand(processEnv);
  const override = resolveExplicitJavaScriptRuntimeCommand(processEnv, params.cwd);

  if (rawOverride && !override) return null;
  if (override) return override;
  if (!params.isBunRuntime) {
    if (
      isRunnableExecutablePath(currentExecPath)
      && (isDirectNodeExecutablePath(currentExecPath) || isManagedJavaScriptRuntimeWrapperPath(currentExecPath))
    ) {
      return currentExecPath;
    }
    return resolveExistingManagedJavaScriptRuntimeCommand(processEnv, params.cwd);
  }
  if (
    isRunnableExecutablePath(currentExecPath)
    && (isDirectNodeExecutablePath(currentExecPath) || isManagedJavaScriptRuntimeWrapperPath(currentExecPath))
  ) {
    return currentExecPath;
  }
  if (isDirectBunExecutablePath(currentExecPath)) return currentExecPath;
  return resolveExistingManagedJavaScriptRuntimeCommand(processEnv, params.cwd);
}

/**
 * Runtime for Happier-owned scripts (the CLI entry, hook forwarders, relays). Under Node the
 * running executable is that runtime whatever its name: a `node` binary, or the Happier single
 * executable, whose embedded main runs `<exe> [--no-warnings] [--no-deprecation] <absolute
 * script> ...args` as Node does. Overrides and Bun processes resolve as
 * `resolveJavaScriptRuntimeCommand`, which third-party Agent CLIs use because they need a
 * runtime named `node`.
 */
export function resolveHappierScriptRuntimeCommand(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: Readonly<Record<string, string | undefined>>;
  currentExecPath?: string | null;
  cwd?: string;
}>): string | null {
  const processEnv = params.processEnv ?? process.env;
  const currentExecPath = String(params.currentExecPath ?? '').trim() || process.execPath;
  if (
    !readExplicitJavaScriptRuntimeCommand(processEnv)
    && typeof process.versions.bun !== 'string'
    && currentExecPath === process.execPath
    && isRunnableExecutablePath(currentExecPath)
  ) {
    return currentExecPath;
  }
  return resolveJavaScriptRuntimeCommand(params);
}

export function resolveDirectJavaScriptRuntimeCommand(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
}>): string | null {
  const runtimeCommand = resolveJavaScriptRuntimeCommand(params);
  if (!runtimeCommand) return null;
  if (
    isDirectNodeExecutablePath(runtimeCommand)
    || isDirectBunExecutablePath(runtimeCommand)
  ) {
    return runtimeCommand;
  }
  if (isManagedJavaScriptRuntimeWrapperPath(runtimeCommand)) {
    return resolveManagedJavaScriptRuntimeBinaryFromWrapper(runtimeCommand);
  }
  return null;
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
  execFileWithDeadline?: typeof execFileWithDeadline;
}>;

const JS_RUNTIME_BOOTSTRAP_LOCK_STALE_MS = 5 * 60 * 1000;

function resolveManagedJavaScriptRuntimeBootstrapLockPath(processEnv: NodeJS.ProcessEnv): string {
  return join(managedJavaScriptRuntimeInstallDir(processEnv), '.lock', 'bootstrap.lock');
}

export async function ensureManagedJavaScriptRuntimeCommand(
  processEnv: NodeJS.ProcessEnv = process.env,
  deps: EnsureManagedJavaScriptRuntimeDeps = {},
  options: Readonly<{ signal?: AbortSignal; onProgress?: AgentInstallProgressCallback; cwd?: string }> = {},
): Promise<string | null> {
  const { signal } = options;
  signal?.throwIfAborted();
  const rawOverride = readExplicitJavaScriptRuntimeCommand(processEnv);
  if (rawOverride) {
    return resolveExplicitJavaScriptRuntimeCommand(processEnv, options.cwd);
  }

  const qualify = async (command: string): Promise<string> => {
    const invocation = resolveWindowsCommandInvocation({ command, args: ['--version'], env: processEnv });
    try {
      await (deps.execFileWithDeadline ?? execFileWithDeadline)(invocation.command, invocation.args, {
        env: processEnv, cwd: options.cwd, encoding: 'utf8', windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments, signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
      const library = /error while loading shared libraries: ([A-Za-z0-9_.+-]+):/u.exec(stderr)?.[1];
      const remedy = library === 'libatomic.so.1'
        ? ' Install the libatomic1 package on Debian/Ubuntu, then retry.' : '';
      throw Object.assign(new Error(`Managed JavaScript runtime is unavailable: ${library ? `missing native library ${library}.` : 'native runtime qualification failed.'}${remedy}`, { cause: error }),
        { code: 'managed-runtime-unavailable' as const });
    }
    return command;
  };
  const existing = resolveExistingManagedJavaScriptRuntimeCommand(processEnv, options.cwd);
  if (existing) return qualify(existing);

  const installDir = managedJavaScriptRuntimeInstallDir(processEnv);
  const nextDir = join(installDir, 'next');
  const nextBinPath = resolveNextManagedJavaScriptRuntimeBinPath(processEnv);
  const fetchNodeRelease = deps.fetchNodeRuntimeReleaseAsset ?? fetchNodeRuntimeReleaseAsset;
  const downloadAsset = deps.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset;
  const extractAsset = deps.extractGitHubReleaseAsset ?? extractGitHubReleaseAsset;
  let waitReported = false;

  try {
    return await withWorkspaceBundleLock(async () => {
      signal?.throwIfAborted();
      const managedAfterLock = resolveExistingManagedJavaScriptRuntimeCommand(processEnv, options.cwd);
      if (managedAfterLock) {
        return qualify(managedAfterLock);
      }

      options.onProgress?.({ t: 'log', line: 'Resolving managed JavaScript runtime release.' });
      const release = await fetchNodeRelease({ processEnv, signal });
      signal?.throwIfAborted();
      const scratchDir = await createManagedToolScratchDir({
        installDir,
        prefix: 'bootstrap',
      });
      try {
        const archivePath = join(scratchDir, release.name);
        const extractDir = join(scratchDir, 'extract');
        const nextRuntimeDir = join(nextDir, 'runtime');
        const nextNodeBinaryPath = resolveNextManagedNodeBinaryPath(processEnv, release.binaryRelativePath);

        options.onProgress?.({ t: 'log', line: 'Downloading managed JavaScript runtime.' });
        await downloadAsset({
          signal,
          onProgress: options.onProgress,
          url: release.url,
          destinationPath: archivePath,
          digest: release.digest,
          userAgent: 'happier-cli',
        });

        signal?.throwIfAborted();
        options.onProgress?.({ t: 'log', line: 'Installing managed JavaScript runtime.' });
        await rm(nextDir, { recursive: true, force: true });
        await extractAsset({
          signal,
          archivePath,
          archiveName: release.name,
          extractDir,
          outputPath: nextRuntimeDir,
          skipTarLinks: true,
        });

        await mkdir(dirname(nextNodeBinaryPath), { recursive: true });
        accessSync(nextNodeBinaryPath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        await writeManagedJavaScriptRuntimeWrapper({
          outputPath: nextBinPath,
          runtimeBinaryPath: process.platform === 'win32' ? '%~dp0..\\runtime\\node.exe' : '${0%/*}/../runtime/bin/node',
        });
        await qualify(nextBinPath);

        signal?.throwIfAborted();
        await promoteManagedCurrentInstall({ signal, installRoot: installDir, candidatePath: nextDir });
        return managedJavaScriptRuntimeBinPath(processEnv);
      } finally {
        try {
          await rm(nextDir, { recursive: true, force: true });
        } finally {
          await removeHappierTempDirAsync(scratchDir);
        }
      }
    }, {
      signal,
      lockPath: resolveManagedJavaScriptRuntimeBootstrapLockPath(processEnv),
      timeoutMs: null,
      staleAfterMs: JS_RUNTIME_BOOTSTRAP_LOCK_STALE_MS,
      errorLabel: 'managed JavaScript runtime bootstrap lock',
      onWait: () => {
        if (waitReported) return;
        waitReported = true;
        options.onProgress?.({ t: 'log', line: 'Waiting for managed JavaScript runtime bootstrap lock.' });
      },
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'managed-runtime-unavailable') throw error;
    throw new Error('Managed JavaScript runtime is unavailable: bootstrap failed', { cause: error });
  }
}
