import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  resolveRuntimeEntrypoint,
  resolveValidRuntimeEntrypoint,
} from './_resolveRuntimeEntrypoint.mjs';

const DEFAULT_HOST_APPS = ['cli'];

function isDisabled(env) {
  const candidates = [
    env?.HAPPIER_SYNC_BUNDLED_WORKSPACES,
    env?.HAPPIER_CLI_SYNC_BUNDLED_WORKSPACES,
  ];

  for (const raw of candidates) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) continue;
    if (value === '0' || value === 'false' || value === 'no') return true;
  }

  return false;
}

function resolveBundledWorkspaceSyncModulePath(projectRoot) {
  const root = String(projectRoot ?? '').trim();
  if (!root) return null;

  const candidate = resolve(root, '..', '..', 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
  return existsSync(candidate) ? candidate : null;
}

function resolveLocalRepoRoot(projectRoot) {
  const syncModulePath = resolveBundledWorkspaceSyncModulePath(projectRoot);
  if (!syncModulePath) return null;
  return resolve(projectRoot, '..', '..');
}

async function buildLocalRuntimeSnapshot(projectRoot, repoRoot, opts, heldLockValue) {
  const buildSharedDepsModulePath = resolve(projectRoot, 'scripts', 'buildSharedDeps.mjs');
  const buildModulePath = resolve(projectRoot, 'scripts', 'build.mjs');
  if (!existsSync(buildSharedDepsModulePath) || !existsSync(buildModulePath)) {
    throw new Error(`Cannot build missing CLI runtime snapshot under ${projectRoot}`);
  }

  const [{ main: buildSharedDeps }, { buildCliDist }] = await Promise.all([
    import(pathToFileURL(buildSharedDepsModulePath).href),
    import(pathToFileURL(buildModulePath).href),
  ]);
  await buildSharedDeps({ skipLock: true });
  const buildEnv = {
    ...(opts.env ?? process.env),
  };
  if (heldLockValue) {
    buildEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = heldLockValue;
  }
  await buildCliDist({
    packageRoot: projectRoot,
    repoRoot,
    lockPath: opts.lockPath,
    lockTimeoutMs: opts.lockTimeoutMs,
    lockPollIntervalMs: opts.lockPollIntervalMs,
    lockStaleAfterMs: opts.lockStaleAfterMs,
    skipLock: true,
    heldLockValue,
    env: buildEnv,
  });
}

function resolveWorkspaceBundleLockModulePath(repoRoot, opts = {}) {
  const explicit = String(opts.lockModulePath ?? '').trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  const candidate = resolve(repoRoot, 'scripts', 'workspaces', 'workspaceBundleLock.mjs');
  return existsSync(candidate) ? candidate : null;
}

function resolveCliSharedDepsBuildLockPath(repoRoot, opts = {}) {
  return String(opts.lockPath ?? resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'));
}

async function withOptionalCliSharedDepsBuildLock(repoRoot, fn, opts = {}) {
  const lockModulePath = resolveWorkspaceBundleLockModulePath(repoRoot, opts);
  if (!lockModulePath) return await fn();

  const mod = await import(pathToFileURL(lockModulePath).href);
  if (typeof mod?.withWorkspaceBundleLock !== 'function') return await fn();

  const lockTimeoutMs = opts.lockTimeoutMs ?? 240_000;
  return await mod.withWorkspaceBundleLock(fn, {
    lockPath: resolveCliSharedDepsBuildLockPath(repoRoot, opts),
    heldLockValue: String(
      opts.heldLockValue
        ?? opts.heldLockPath
        ?? (opts.env ?? process.env)?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD
        ?? '',
    ).trim(),
    timeoutMs: lockTimeoutMs,
    pollIntervalMs: opts.lockPollIntervalMs ?? 250,
    staleAfterMs: opts.lockStaleAfterMs ?? lockTimeoutMs,
  });
}

export async function maybeRefreshLocalBundledWorkspacePackages(projectRoot, opts = {}) {
  if (isDisabled(opts.env ?? process.env)) return;

  const syncModulePath = resolveBundledWorkspaceSyncModulePath(projectRoot);
  if (!syncModulePath) return;

  const repoRoot = resolve(projectRoot, '..', '..');
  await withOptionalCliSharedDepsBuildLock(repoRoot, async () => {
    const { syncBundledWorkspacePackages } = await import(pathToFileURL(syncModulePath).href);

    syncBundledWorkspacePackages({
      repoRoot,
      hostApps: Array.isArray(opts.hostApps) && opts.hostApps.length > 0 ? opts.hostApps : DEFAULT_HOST_APPS,
      // Preflight should be "presence-only" and avoid swapping an existing `dist/**` directory out from
      // under other running processes in a dev checkout.
      replaceExisting: false,
    });
  }, {
    lockPath: opts.lockPath,
    lockModulePath: opts.lockModulePath,
    lockTimeoutMs: opts.lockTimeoutMs,
    lockPollIntervalMs: opts.lockPollIntervalMs,
    lockStaleAfterMs: opts.lockStaleAfterMs,
    env: opts.env,
  });
}

export async function prepareRuntimeEntrypoint(projectRoot, relativePath, opts = {}) {
  const physicalProjectRoot = realpathSync.native(resolve(projectRoot));
  const repoRoot = resolveLocalRepoRoot(physicalProjectRoot);
  if (!repoRoot) {
    return resolveRuntimeEntrypoint(physicalProjectRoot, relativePath);
  }

  const readyEntrypoint = resolveValidRuntimeEntrypoint(physicalProjectRoot, relativePath);
  if (readyEntrypoint) return readyEntrypoint;

  return await withOptionalCliSharedDepsBuildLock(repoRoot, async ({ heldLockValue } = {}) => {
    const concurrentlyBuiltEntrypoint = resolveValidRuntimeEntrypoint(physicalProjectRoot, relativePath);
    if (concurrentlyBuiltEntrypoint) return concurrentlyBuiltEntrypoint;

    await buildLocalRuntimeSnapshot(physicalProjectRoot, repoRoot, opts, heldLockValue);
    const builtEntrypoint = resolveValidRuntimeEntrypoint(physicalProjectRoot, relativePath);
    if (!builtEntrypoint) {
      throw new Error(`CLI build completed without a valid runtime snapshot under ${physicalProjectRoot}`);
    }
    return builtEntrypoint;
  }, {
    lockPath: opts.lockPath,
    lockModulePath: opts.lockModulePath,
    lockTimeoutMs: opts.lockTimeoutMs,
    lockPollIntervalMs: opts.lockPollIntervalMs,
    lockStaleAfterMs: opts.lockStaleAfterMs,
    env: opts.env,
  });
}
