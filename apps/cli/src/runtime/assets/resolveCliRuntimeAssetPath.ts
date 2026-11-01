import { join } from 'node:path';

import {
  isSelfContainedCliBinary,
  resolveSelfContainedCliRuntimeRootPath,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { projectPath, projectPathFromModuleUrl } from '@/projectPath';

export { isSelfContainedCliBinary };

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
  const selfContainedRuntimeRoot = resolveSelfContainedCliRuntimeRootPath(execPath);
  if (selfContainedRuntimeRoot) {
    return selfContainedRuntimeRoot;
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
