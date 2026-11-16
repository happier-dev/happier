import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveSelfContainedCliRuntimeRootPath } from '../firstPartyRuntime/resolveSelfContainedCliRuntimeRoot.js';

export const PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME = 'happier-process-custody';

type RuntimeAssetPath = (...segments: string[]) => string | null;

function resolvePackagedRuntimeAssetPath(...segments: string[]): string | null {
  const root = resolveSelfContainedCliRuntimeRootPath();
  return root ? join(root, ...segments) : null;
}

function resolveStagedBinary(executableName: string, resolveAssetPath: RuntimeAssetPath): string | null {
  for (const prefix of [['tools', 'unpacked'], ['apps', 'cli', 'tools', 'unpacked']]) {
    const path = resolveAssetPath(...prefix, executableName);
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** One staged-path owner; source CLI callers supply their existing source-root adapter. */
export function resolveProcessCustodySupportExecutable(
  platform: NodeJS.Platform = process.platform,
  resolveAssetPath: RuntimeAssetPath = resolvePackagedRuntimeAssetPath,
): string | null {
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') return null;
  const name = PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME + (platform === 'win32' ? '.exe' : '');
  return resolveStagedBinary(name, resolveAssetPath);
}

/** Static Linux targets or the matching controller's published Darwin helper. */
export function resolveProcessCustodyTargetExecutable(
  arch: 'x64' | 'arm64',
  platform: 'linux' | 'darwin' = 'linux',
  resolveAssetPath: RuntimeAssetPath = resolvePackagedRuntimeAssetPath,
): string | null {
  if (platform === 'darwin') {
    return process.platform === 'darwin' && process.arch === arch
      ? resolveProcessCustodySupportExecutable('darwin', resolveAssetPath) : null;
  }
  return resolveStagedBinary(join('targets', `${PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME}.linux-${arch}`), resolveAssetPath);
}
