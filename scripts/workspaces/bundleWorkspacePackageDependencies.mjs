import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from './ensureWorkspacePackagesBuilt.mjs';
import { loadCliCommonWorkspacesModule as loadCliCommonWorkspacesModuleDefault } from './loadCliCommonWorkspacesModule.mjs';
import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock as withWorkspaceBundleLockDefault,
} from './workspaceBundleLock.mjs';

const WORKSPACE_DIST_BUILD_LOCK_HELD_ENV_VAR = 'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD';

/** Finds the monorepo root for package-local command adapters. */
export function findWorkspaceRepositoryRoot(startDir) {
  let directory = resolve(startDir);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(resolve(directory, 'package.json')) && existsSync(resolve(directory, 'yarn.lock'))) {
      return directory;
    }
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not find the workspace repository root from ${startDir}`);
}

function resolveBundlePackageNames(bundles) {
  return [...new Set(
    bundles
      .map((bundle) => String(bundle?.packageName ?? bundle?.name ?? '').trim())
      .filter(Boolean),
  )];
}

/**
 * Canonical generic publication path for a package's declared bundled
 * workspace dependencies. Package adapters own prerequisites and additional
 * verification; this owner resolves, admits, and copies the dependency graph.
 */
export async function bundleWorkspacePackageDependencies(options) {
  const repoRoot = resolve(options.repoRoot);
  const hostPackageDir = resolve(options.hostPackageDir);
  const publicationMode = options.publicationMode ?? 'live';
  const forceArtifactWorkspaceBuilds = publicationMode === 'artifact';
  const quiet = options.quiet ?? false;
  const baseEnv = options.env ?? process.env;
  const ensureWorkspacePackagesBuiltByName = options.ensureWorkspacePackagesBuiltByName
    ?? ensureWorkspacePackagesBuiltByNameDefault;
  const loadCliCommonWorkspacesModule = options.loadCliCommonWorkspacesModule
    ?? loadCliCommonWorkspacesModuleDefault;
  const withWorkspaceBundleLock = options.withWorkspaceBundleLock
    ?? withWorkspaceBundleLockDefault;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS;

  const workspaceModule = await loadCliCommonWorkspacesModule(
    repoRoot,
    baseEnv,
    ensureWorkspacePackagesBuiltByName,
    {
      force: forceArtifactWorkspaceBuilds,
      includeDevDependencies: false,
      publicationMode,
      quiet,
    },
  );
  const bundles = workspaceModule.resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir,
  });
  const packageNames = resolveBundlePackageNames(bundles);
  if (packageNames.length > 0) {
    await ensureWorkspacePackagesBuiltByName(repoRoot, packageNames, {
      quiet,
      env: baseEnv,
      includeDevDependencies: false,
      publicationMode,
      ...(forceArtifactWorkspaceBuilds ? { force: true } : {}),
    });
  }

  const prepared = await withWorkspaceBundleLock(async (lock) => {
    // Package compilation is intentionally complete before this shared lock. Publication and the
    // prepared reader are one transaction: reconciliation replaces the dependency tree entry by
    // entry, so a reader released early can resolve one file from the new generation and its
    // import target from the previous one.
    workspaceModule.bundleWorkspacePackagesWithRuntimeDependencies({
      bundles,
      publicationMode,
      pruneStale: options.pruneStale,
    });
    if (options.consumePreparedWorkspace) {
      // The reader keeps the caller's staging, prerequisite, and package-lock context, plus the
      // lease that owns the held lock: a prepared script that republishes the graph itself, such
      // as `prepack`, must reenter this exact lock instead of waiting for its own owner.
      await options.consumePreparedWorkspace({
        bundles,
        preparedWorkspaceEnv: {
          ...baseEnv,
          ...(lock.heldLockValue
            ? { [WORKSPACE_DIST_BUILD_LOCK_HELD_ENV_VAR]: lock.heldLockValue }
            : {}),
        },
      });
    }
    return { bundles };
  }, {
    lockPath: options.lockPath ?? resolveWorkspaceBundleLockPath(repoRoot),
    heldLockValue: String(
      options.heldLockValue
        ?? options.heldLockPath
        ?? baseEnv?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD
        ?? '',
    ).trim(),
    timeoutMs: lockTimeoutMs,
    pollIntervalMs: options.lockPollIntervalMs ?? 250,
    staleAfterMs: options.lockStaleAfterMs ?? lockTimeoutMs,
  });

  return prepared;
}
