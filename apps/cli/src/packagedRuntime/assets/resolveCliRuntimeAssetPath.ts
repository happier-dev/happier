import { basename, dirname, join } from 'node:path';

import { projectPath, projectPathFromModuleUrl } from '../../projectPath';
import { isEmbeddedBunBundlePath } from '../js/isEmbeddedBunBundlePath';
import { resolveRuntimeRootFromEntrypointPath } from '../resolveRuntimeEntrypointArgv';

const RUNTIME_BACKED_SUBPROCESS_ENV = 'HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED';
const RUNTIME_DIST_ENTRYPOINT_ENV = 'HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT';
const RUNTIME_DIST_CLOSURE_FINGERPRINT_ENV = 'HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT';

function normalizePathLike(pathLike: string): string {
  return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

function isRuntimeExecutablePath(pathLike: string): boolean {
  const base = basename(normalizePathLike(pathLike)).toLowerCase();
  return base === 'node' || base === 'node.exe' || base === 'bun' || base === 'bun.exe';
}

function resolveCliInstallRootNameFromShim(executableBase: string): string | null {
  const normalizedBase = executableBase.toLowerCase().replace(/\.exe$/u, '');
  if (normalizedBase === 'happier') {
    return 'cli';
  }
  if (normalizedBase === 'hprev') {
    return 'cli-preview';
  }
  if (normalizedBase === 'hdev') {
    return 'cli-dev';
  }
  return null;
}

export function isSelfContainedCliBinary(execPath: string = process.execPath): boolean {
  const normalized = normalizePathLike(execPath);
  if (!normalized) return false;
  return !isRuntimeExecutablePath(normalized);
}

function resolveInstalledCliRuntimeRootPath(execPath: string): string | null {
  const normalized = normalizePathLike(execPath);
  if (!normalized || !isSelfContainedCliBinary(normalized)) {
    return null;
  }

  const installRootName = resolveCliInstallRootNameFromShim(basename(normalized));
  if (!installRootName) {
    return null;
  }

  const binaryDir = dirname(normalized);
  if (basename(binaryDir).toLowerCase() !== 'bin') {
    return null;
  }

  return join(dirname(binaryDir), installRootName, 'current');
}

function resolveAdmittedRuntimeRootFromLaunchProvenance(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // The Stack projects this tuple only after admitting the immutable CLI closure.
  // Bun's embedded paths are process-local, so this physical entrypoint is the
  // launch authority for support files that remain outside the compiled binary.
  if (String(env[RUNTIME_BACKED_SUBPROCESS_ENV] ?? '').trim() !== '1') {
    return null;
  }
  const fingerprint = String(env[RUNTIME_DIST_CLOSURE_FINGERPRINT_ENV] ?? '').trim();
  if (!/^[a-f0-9]{16}$/iu.test(fingerprint)) {
    return null;
  }
  return resolveRuntimeRootFromEntrypointPath(env[RUNTIME_DIST_ENTRYPOINT_ENV]);
}

export function resolveCliRuntimeRootPath(execPath: string = process.execPath): string {
  return resolveCliRuntimeRootPathFromModuleUrl(execPath, import.meta.url);
}

export function resolveCliRuntimeRootPathFromModuleUrl(
  execPath: string = process.execPath,
  moduleUrl: string,
): string {
  const normalizedExecPath = normalizePathLike(execPath);
  if (isEmbeddedBunBundlePath(normalizedExecPath)) {
    const admittedRuntimeRoot = resolveAdmittedRuntimeRootFromLaunchProvenance();
    if (admittedRuntimeRoot) {
      return admittedRuntimeRoot;
    }
  }

  const installedCliRuntimeRoot = resolveInstalledCliRuntimeRootPath(execPath);
  if (installedCliRuntimeRoot) {
    return installedCliRuntimeRoot;
  }

  if (isSelfContainedCliBinary(normalizedExecPath)) {
    return dirname(normalizedExecPath);
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
