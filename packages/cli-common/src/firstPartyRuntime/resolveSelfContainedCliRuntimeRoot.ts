import { basename, dirname } from 'node:path';

import { FIRST_PARTY_INSTALL_HOME_ENV_KEY, resolveFirstPartyInstallLayout, type FirstPartyInstallLayout } from './installLayout.js';
import { resolveManagedCliShimInstall } from './managedCliShimInstall.js';
import { resolveJunctionFreeCurrentPath } from './resolveJunctionFreeCurrentPath.js';
import { isEmbeddedBunBundlePath, resolveRuntimeRootFromEntrypointPath } from './runtimePaths.js';

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

/** Resolve the installation owned by the launched managed shim. */
export function resolveInstalledCliRuntimeLayout(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
): FirstPartyInstallLayout | null {
  if (!isSelfContainedCliBinary(execPath)) return null;
  const shimInstall = resolveManagedCliShimInstall(execPath, env);
  if (!shimInstall) return null;
  return resolveFirstPartyInstallLayout({
    componentId: 'happier-cli',
    channel: shimInstall.channel,
    processEnv: { ...env, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: shimInstall.installHomeDir },
  });
}

/** Resolve a managed shim's active payload through its install home and version marker. */
export function resolveInstalledCliRuntimeRootPath(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const layout = resolveInstalledCliRuntimeLayout(execPath, env);
  return layout ? resolveJunctionFreeCurrentPath(layout) : null;
}

/**
 * Runtime root of a self-contained first-party binary: the installed active payload when
 * launched through a `<home>/bin` CLI shortcut (shortcuts are hardlinks or copies,
 * so `execPath` is the shortcut), otherwise the binary's own directory. Reads `current.version`
 * to bypass junctions, with `current` retained for legacy installs. `null` for node/bun.
 */
export function resolveSelfContainedCliRuntimeRootPath(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Embedded Bun paths name process-local virtual files. The Stack publishes this tuple only
  // after admitting the physical CLI closure, which also owns support files outside the binary.
  if (isEmbeddedBunBundlePath(execPath)
    && String(env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED ?? '').trim() === '1'
    && /^[a-f0-9]{16}$/iu.test(String(env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT ?? '').trim())) {
    const admittedRoot = resolveRuntimeRootFromEntrypointPath(env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT);
    if (admittedRoot) return admittedRoot;
  }
  const installedCliRuntimeRoot = resolveInstalledCliRuntimeRootPath(execPath, env);
  if (installedCliRuntimeRoot) return installedCliRuntimeRoot;
  const normalized = normalizePathLike(execPath);
  return isSelfContainedCliBinary(normalized) ? dirname(normalized) : null;
}
