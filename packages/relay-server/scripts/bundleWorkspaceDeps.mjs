import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { loadCliCommonWorkspacesModule } from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const relayDir = opts.relayDir ?? resolve(repoRoot, 'packages', 'relay-server');
  const lockPath = opts.lockPath ?? resolveWorkspaceBundleLockPath(repoRoot);
  const baseEnv = opts.env ?? process.env;
  const publicationMode = opts.publicationMode ?? 'live';
  const forceArtifactWorkspaceBuilds = publicationMode === 'artifact';
  const ensureWorkspacePackagesBuiltByName = opts.ensureWorkspacePackagesBuiltByName
    ?? ensureWorkspacePackagesBuiltByNameDefault;

  return withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const heldLockEnv = createWorkspaceChildBuildEnv({
      env: baseEnv,
      heldLockValue,
    });
    const {
      bundleWorkspacePackagesWithRuntimeDependencies,
      resolveWorkspaceBundlesFromPackageJson,
    } = await loadCliCommonWorkspacesModule(
      repoRoot,
      heldLockEnv,
      ensureWorkspacePackagesBuiltByName,
      {
        force: forceArtifactWorkspaceBuilds,
        includeDevDependencies: false,
        publicationMode,
        quiet: false,
      },
    );

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: relayDir,
    });
    await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      [...new Set(bundles.map((bundle) => String(bundle?.packageName ?? bundle?.name ?? '').trim()).filter(Boolean))],
      {
        quiet: false,
        env: heldLockEnv,
        includeDevDependencies: false,
        publicationMode,
        ...(forceArtifactWorkspaceBuilds
          ? { force: true }
          : {}),
      },
    );

    bundleWorkspacePackagesWithRuntimeDependencies({
      bundles,
      publicationMode,
    });
  }, {
    lockPath,
    heldLockValue: String(
      opts.heldLockValue
        ?? opts.heldLockPath
        ?? baseEnv?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD
        ?? '',
    ).trim(),
    timeoutMs: DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
    pollIntervalMs: 250,
    staleAfterMs: DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    await bundleWorkspaceDeps({
      publicationMode: resolveWorkspaceBundlePublicationMode({
        argv: process.argv.slice(2),
        env: process.env,
      }),
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
