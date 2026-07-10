import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
  withWorkspaceBundleLockSync,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

export { withWorkspaceBundleLock, withWorkspaceBundleLockSync } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

export function findRepoRoot(startDir) {
  let dir = resolve(String(startDir ?? process.cwd()));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(String(startDir ?? process.cwd()), '..', '..');
}

export function resolveCliSharedDepsBuildLockPath(repoRoot) {
  return resolveWorkspaceBundleLockPath(repoRoot);
}

function resolveInheritedWorkspaceBundleLockPath(options) {
  const env = options.env ?? process.env;
  return String(options.heldLockPath ?? env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? '').trim();
}

export function resolveWorkspaceBundleLockModulePath(repoRoot) {
  const candidate = resolve(repoRoot, 'scripts', 'workspaces', 'workspaceBundleLock.mjs');
  return existsSync(candidate) ? candidate : null;
}

export async function withOptionalCliSharedDepsBuildLock(fn, options = {}) {
  if (options.skipLock === true) {
    return await fn();
  }
  const repoRoot = resolve(String(options.repoRoot ?? findRepoRoot(options.startDir)));
  const explicitLockPath = String(options.lockPath ?? '').trim();
  const lockModulePath = String(options.lockModulePath ?? resolveWorkspaceBundleLockModulePath(repoRoot) ?? '').trim();
  if (explicitLockPath && (!lockModulePath || !existsSync(lockModulePath))) {
    const lockTimeoutMs = options.lockTimeoutMs ?? options.timeoutMs ?? 240_000;
    return await withWorkspaceBundleLock(fn, {
      lockPath: explicitLockPath,
      heldLockPath: resolveInheritedWorkspaceBundleLockPath(options),
      timeoutMs: lockTimeoutMs,
      pollIntervalMs: options.lockPollIntervalMs ?? options.pollIntervalMs ?? 250,
      staleAfterMs: options.lockStaleAfterMs ?? options.staleAfterMs ?? lockTimeoutMs,
    });
  }
  if (!lockModulePath || !existsSync(lockModulePath)) {
    return await fn();
  }

  const mod = await import(pathToFileURL(lockModulePath).href);
  if (typeof mod?.withWorkspaceBundleLock !== 'function') {
    return await fn();
  }

  const lockTimeoutMs = options.lockTimeoutMs ?? options.timeoutMs ?? 240_000;
  return await mod.withWorkspaceBundleLock(fn, {
    lockPath: String(options.lockPath ?? resolveCliSharedDepsBuildLockPath(repoRoot)),
    heldLockPath: resolveInheritedWorkspaceBundleLockPath(options),
    timeoutMs: lockTimeoutMs,
    pollIntervalMs: options.lockPollIntervalMs ?? options.pollIntervalMs ?? 250,
    staleAfterMs: options.lockStaleAfterMs ?? options.staleAfterMs ?? lockTimeoutMs,
  });
}

export function withOptionalCliSharedDepsBuildLockSync(fn, options = {}) {
  if (options.skipLock === true) {
    return fn();
  }
  const repoRoot = resolve(String(options.repoRoot ?? findRepoRoot(options.startDir)));
  const explicitLockPath = String(options.lockPath ?? '').trim();
  const lockModulePath = String(options.lockModulePath ?? resolveWorkspaceBundleLockModulePath(repoRoot) ?? '').trim();
  if (!explicitLockPath && (!lockModulePath || !existsSync(lockModulePath))) {
    return fn();
  }

  const lockPath = explicitLockPath || resolveCliSharedDepsBuildLockPath(repoRoot);
  const timeoutMs = options.lockTimeoutMs ?? options.timeoutMs ?? 240_000;
  return withWorkspaceBundleLockSync(fn, {
    lockPath,
    heldLockPath: resolveInheritedWorkspaceBundleLockPath(options),
    timeoutMs,
    pollIntervalMs: options.lockPollIntervalMs ?? options.pollIntervalMs ?? 250,
    staleAfterMs: options.lockStaleAfterMs ?? options.staleAfterMs ?? timeoutMs,
  });
}
