import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveRuntimeEntrypoint } from './_resolveRuntimeEntrypoint.mjs';

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

function resolveWorkspaceBundleLockModulePath(repoRoot, opts = {}) {
  const explicit = String(opts.lockModulePath ?? '').trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  const candidate = resolve(repoRoot, 'scripts', 'workspaces', 'workspaceBundleLock.mjs');
  return existsSync(candidate) ? candidate : null;
}

function resolveCliSharedDepsBuildLockPath(repoRoot, opts = {}) {
  return String(
    opts.sharedDepsLockPath
      ?? opts.lockPath
      ?? resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps.lock'),
  );
}

async function withOptionalWorkspaceBuildLock(repoRoot, fn, opts, resolveLockPath) {
  const lockModulePath = resolveWorkspaceBundleLockModulePath(repoRoot, opts);
  if (!lockModulePath) return await fn();

  const mod = await import(pathToFileURL(lockModulePath).href);
  if (typeof mod?.withWorkspaceBundleLock !== 'function') return await fn();

  const lockTimeoutMs = opts.lockTimeoutMs ?? 240_000;
  return await mod.withWorkspaceBundleLock(fn, {
    lockPath: resolveLockPath(repoRoot, opts),
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

async function withOptionalCliSharedDepsBuildLock(repoRoot, fn, opts = {}) {
  return await withOptionalWorkspaceBuildLock(
    repoRoot,
    fn,
    opts,
    resolveCliSharedDepsBuildLockPath,
  );
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
    lockPath: opts.sharedDepsLockPath ?? opts.lockPath,
    lockModulePath: opts.lockModulePath,
    lockTimeoutMs: opts.lockTimeoutMs,
    lockPollIntervalMs: opts.lockPollIntervalMs,
    lockStaleAfterMs: opts.lockStaleAfterMs,
    env: opts.env,
  });
}

export async function prepareRuntimeEntrypoint(projectRoot, relativePath) {
  const physicalProjectRoot = realpathSync.native(resolve(projectRoot));
  const repoRoot = resolveLocalRepoRoot(physicalProjectRoot);
  if (!repoRoot) {
    return resolveRuntimeEntrypoint(physicalProjectRoot, relativePath);
  }

  // Repository wrappers consume authored exports, just like other source tools.
  // A valid compiled closure proves integrity, not freshness against moving source.
  const { resolveWorkspaceSource } = await import(pathToFileURL(
    resolve(repoRoot, 'packages', 'cli-common', 'sourceRuntimeEntries.mjs'),
  ).href);
  const manifest = JSON.parse(readFileSync(resolve(physicalProjectRoot, 'package.json'), 'utf8'));
  const subpath = relativePath.replaceAll('\\', '/').replace(/\.mjs$/, '');
  const specifier = subpath === 'index' ? manifest.name : `${manifest.name}/${subpath}`;
  return resolveWorkspaceSource(new Map([[manifest.name, { root: physicalProjectRoot, manifest }]]), specifier);
}
