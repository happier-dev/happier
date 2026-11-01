import { basename, dirname, join } from 'node:path';

import { projectPath, projectPathFromModuleUrl } from '@/projectPath';
import { resolveManagedCliShimInstall } from '@/runtime/managedCliShimInstall';

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

export function resolveCliRuntimeRootPathFromModuleUrl(moduleUrl: string): string | null {
  try {
    return projectPathFromModuleUrl(moduleUrl);
  } catch {
    return null;
  }
}

export function resolveCliRuntimeRootPath(
  execPath: string = process.execPath,
  moduleUrl: string = import.meta.url,
): string {
  const installedCliRuntimeRoot = resolveInstalledCliRuntimeRootPath(execPath);
  if (installedCliRuntimeRoot) {
    return installedCliRuntimeRoot;
  }

  const normalizedExecPath = normalizePathLike(execPath);
  if (isSelfContainedCliBinary(normalizedExecPath)) {
    return dirname(normalizedExecPath);
  }

  const moduleRuntimeRoot = resolveCliRuntimeRootPathFromModuleUrl(moduleUrl);
  if (moduleRuntimeRoot) {
    return moduleRuntimeRoot;
  }

  return projectPath();
}

export function resolveCliRuntimeAssetPathFromModuleUrl(moduleUrl: string, ...segments: string[]): string {
  return join(resolveCliRuntimeRootPath(process.execPath, moduleUrl), ...segments);
}

export function resolveCliRuntimeAssetPath(...segments: string[]): string {
  return resolveCliRuntimeAssetPathFromModuleUrl(import.meta.url, ...segments);
}
