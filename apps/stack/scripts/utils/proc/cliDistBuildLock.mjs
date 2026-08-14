import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function workspaceBundleLockModuleOwnsDefault(module) {
  return typeof module?.observeWorkspaceBundleLock === 'function'
    && typeof module?.WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE === 'string'
    && Number.isFinite(module?.DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS)
    && module.DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS > 0;
}

export async function loadWorkspaceBundleLockModule(options = {}) {
  const importPackageModule = options.importPackageModule
    ?? (() => import('@happier-dev/cli-common/workspaceBundleLock'));
  const existsSyncImpl = options.existsSyncImpl ?? existsSync;
  const importModule = options.importModule ?? ((moduleUrl) => import(moduleUrl));
  let packageModule = null;
  try {
    packageModule = await importPackageModule();
    if (workspaceBundleLockModuleOwnsDefault(packageModule)) {
      return packageModule;
    }
  } catch (packageImportError) {
    packageModule = { packageImportError };
  }
  // Source-dev upgrades may execute this stack file before the mounted cli-common copy has been
  // refreshed with a newly-added export. Fall back only to the canonical source module; packed
  // stacks resolve the bundled package export above.
  const sourceModulePath = options.sourceModulePath ?? resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../packages/cli-common/workspaceBundleLock.mjs',
  );
  if (!existsSyncImpl(sourceModulePath)) {
    if (packageModule?.packageImportError) throw packageModule.packageImportError;
    throw new Error('Workspace bundle lock module is missing its canonical timeout default');
  }
  const sourceModule = await importModule(pathToFileURL(sourceModulePath).href);
  if (!workspaceBundleLockModuleOwnsDefault(sourceModule)) {
    throw new Error('Canonical workspace bundle lock source is missing its timeout default');
  }
  return sourceModule;
}

const {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE,
  isWorkspaceBundleLockActive,
  observeWorkspaceBundleLock,
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} = await loadWorkspaceBundleLockModule();

export { WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE };

// Source-dev publishers can legitimately hold this lock while they rebuild and
// republish a large workspace closure. Four minutes was shorter than observed
// healthy publishers under concurrent local agent load, causing stack startup
// to fail even though the owner was alive and heartbeating.
export const DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS = DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS;

export function resolveCliDistBuildLockPath(repoRoot) {
  return resolveWorkspaceBundleLockPath(repoRoot);
}

export function isCliDistBuildLockActive(lockPath, options = {}) {
  return isWorkspaceBundleLockActive(lockPath, {
    staleAfterMs: options.staleAfterMs ?? DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS,
    nowMs: options.nowMs ?? Date.now(),
  });
}

export function observeCliDistBuildLock(lockPath, options = {}) {
  return observeWorkspaceBundleLock(lockPath, {
    staleAfterMs: options.staleAfterMs ?? DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS,
    nowMs: options.nowMs ?? Date.now(),
  });
}

export async function withCliDistBuildLock(fn, options = {}) {
  const lockPath = options.lockPath;
  if (!lockPath) {
    throw new Error('withCliDistBuildLock requires options.lockPath');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;

  return withWorkspaceBundleLock(
    ({ waited, heldLockValue, inherited }) => fn({ waited, heldLockValue, inherited }),
    {
      lockPath,
      heldLockValue: options.heldLockValue
        ?? options.heldLockPath
        ?? options.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      timeoutMs,
      pollIntervalMs,
      staleAfterMs,
      errorLabel: 'CLI dist build lock',
      tryResolveWaiter: options.tryResolveWaiter,
      onWait: typeof options.onWait === 'function'
        ? (event) => options.onWait({
          lockPath,
          owner: event.owner,
          staleAfterMs,
          timeoutMs,
          waitedMs: event.waitedMs,
        })
        : undefined,
    },
  );
}
