import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadWorkspaceBundleLockModule() {
  let packageModule = null;
  try {
    packageModule = await import('@happier-dev/cli-common/workspaceBundleLock');
    if (
      typeof packageModule.observeWorkspaceBundleLock === 'function'
      && typeof packageModule.WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE === 'string'
    ) {
      return packageModule;
    }
  } catch (packageImportError) {
    packageModule = { packageImportError };
  }
  // Source-dev upgrades may execute this stack file before the mounted cli-common copy has been
  // refreshed with a newly-added export. Fall back only to the canonical source module; packed
  // stacks resolve the bundled package export above.
  const sourceModulePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../packages/cli-common/workspaceBundleLock.mjs',
  );
  if (!existsSync(sourceModulePath)) {
    if (packageModule?.packageImportError) throw packageModule.packageImportError;
    return packageModule;
  }
  return await import(pathToFileURL(sourceModulePath).href);
}

const {
  WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE,
  isWorkspaceBundleLockActive,
  observeWorkspaceBundleLock,
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} = await loadWorkspaceBundleLockModule();

export { WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE };

export const DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS = 240_000;

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
