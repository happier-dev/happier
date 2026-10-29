import { join } from 'node:path';

import { resolveSelfContainedCliRuntimeRootPath } from '@happier-dev/cli-common/firstPartyRuntime';
import { projectPath, projectPathFromModuleUrl } from '../../projectPath';

export { isSelfContainedCliBinary } from '@happier-dev/cli-common/firstPartyRuntime';
export function resolveCliRuntimeRootPath(execPath: string = process.execPath): string {
  return resolveCliRuntimeRootPathFromModuleUrl(execPath, import.meta.url);
}

export function resolveCliRuntimeRootPathFromModuleUrl(
  execPath: string = process.execPath,
  moduleUrl: string,
): string {
  const physicalRuntimeRoot = resolveSelfContainedCliRuntimeRootPath(execPath);
  if (physicalRuntimeRoot) {
    return physicalRuntimeRoot;
  }
  try {
    return projectPathFromModuleUrl(moduleUrl);
  } catch {
    return projectPath();
  }
}

export function resolveCliRuntimeAssetPath(...segments: string[]): string {
  return resolveCliRuntimeAssetPathFromModuleUrl(import.meta.url, ...segments);
}

export function resolveCliRuntimeAssetPathFromModuleUrl(moduleUrl: string, ...segments: string[]): string {
  return join(resolveCliRuntimeRootPathFromModuleUrl(process.execPath, moduleUrl), ...segments);
}
