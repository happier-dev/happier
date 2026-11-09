import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import {
  ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault,
} from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { createWorkspaceBuildWaitNotifier } from './utils/proc/workspaceBuildWaitNotifier.mjs';
import { loadCliCommonWorkspacesModule } from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { syncBundledWorkspacePackages } from '../../../scripts/workspaces/syncBundledWorkspacePackages.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveBundlePackageName(bundle) {
  return String(bundle?.packageName ?? bundle?.name ?? '').trim();
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'pnpm-lock.yaml')) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
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
  const stackDir = opts.stackDir ?? resolve(repoRoot, 'apps', 'stack');
  const lockPath = opts.lockPath ?? resolveWorkspaceBundleLockPath(repoRoot);
  const baseEnv = opts.env ?? process.env;
  const publicationMode = opts.publicationMode ?? 'live';
  const ensureWorkspacePackagesBuiltByName = opts.ensureWorkspacePackagesBuiltByName
    ?? ensureWorkspacePackagesBuiltByNameDefault;

  const heldLockValue = String(
    opts.heldLockValue ?? opts.heldLockPath ?? baseEnv?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? '',
  ).trim();
  // Producers own resource-first admission. Complete their preparation before
  // taking the shared publication lease, as the generic workspace bundler does.
  const producerEnv = createWorkspaceChildBuildEnv({ env: baseEnv, heldLockValue });
  const workspaceModule = await loadCliCommonWorkspacesModule(
    repoRoot,
    producerEnv,
    ensureWorkspacePackagesBuiltByName,
    {
      includeDevDependencies: false,
      publicationMode,
      quiet: true,
    },
  );

  const bundles = workspaceModule.resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: stackDir,
  });
  await ensureWorkspacePackagesBuiltByName(
    repoRoot,
    [...new Set(bundles.map(resolveBundlePackageName).filter(Boolean))],
    {
      quiet: true,
      env: producerEnv,
      includeDevDependencies: false,
      publicationMode,
    },
  );

  return withWorkspaceBundleLock(async () => {
    syncBundledWorkspacePackages({
      repoRoot,
      publicationMode,
      packages: bundles.map(bundle => resolveBundlePackageName(bundle).slice('@happier-dev/'.length)),
      hostPackageDirs: [stackDir],
      cliCommonWorkspacesModule: workspaceModule,
      pruneStale: publicationMode === 'artifact',
    });
  }, {
    lockPath,
    heldLockValue,
    timeoutMs: DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
    pollIntervalMs: 250,
    staleAfterMs: DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
    onWait: createWorkspaceBuildWaitNotifier({ env: baseEnv, label: 'Stack workspace publication', kind: 'lock' }),
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
