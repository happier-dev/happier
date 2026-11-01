import { basename, dirname, join } from 'node:path';

import { resolveManagedCliShimInstall } from './managedCliShimInstall.js';

function normalizePathLike(pathLike: string): string {
  return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

function isRuntimeExecutablePath(pathLike: string): boolean {
  const base = basename(normalizePathLike(pathLike)).toLowerCase();
  return base === 'node' || base === 'node.exe' || base === 'bun' || base === 'bun.exe';
}

export function isSelfContainedCliBinary(execPath: string = process.execPath): boolean {
  const normalized = normalizePathLike(execPath);
  if (!normalized) return false;
  return !isRuntimeExecutablePath(normalized);
}

function resolveInstalledCliRuntimeRootPath(execPath: string): string | null {
  if (!isSelfContainedCliBinary(execPath)) {
    return null;
  }

  const shimInstall = resolveManagedCliShimInstall(execPath);
  if (!shimInstall) {
    return null;
  }

  return join(shimInstall.happierHomeDir, shimInstall.installRootName, 'current');
}

/**
 * Runtime root of a self-contained first-party binary: the installed `<home>/<cli root>/current`
 * payload when launched through a `<home>/bin` CLI shortcut (shortcuts are hardlinks or copies,
 * so `execPath` is the shortcut), otherwise the binary's own directory. `null` for node/bun.
 */
export function resolveSelfContainedCliRuntimeRootPath(execPath: string = process.execPath): string | null {
  const installedCliRuntimeRoot = resolveInstalledCliRuntimeRootPath(execPath);
  if (installedCliRuntimeRoot) return installedCliRuntimeRoot;
  const normalized = normalizePathLike(execPath);
  return isSelfContainedCliBinary(normalized) ? dirname(normalized) : null;
}
