import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault } from '../../../apps/stack/scripts/utils/proc/pm.mjs';
import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { loadCliCommonWorkspacesModule } from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

export function resolvePluginSdkWorkspaceBundleLockPath({ repoRoot, lockPath = '' }) {
  const explicitLockPath = String(lockPath ?? '').trim();
  return explicitLockPath || resolveWorkspaceBundleLockPath(repoRoot);
}

export async function preparePluginSdkWorkspacePrerequisites(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const pluginSdkDir = opts.pluginSdkDir ?? resolve(repoRoot, 'packages', 'plugin-sdk');
  const ensureWorkspacePackagesBuiltForComponent = opts.ensureWorkspacePackagesBuiltForComponent
    ?? ensureWorkspacePackagesBuiltForComponentDefault;
  return await ensureWorkspacePackagesBuiltForComponent(pluginSdkDir, {
    env: opts.env ?? process.env,
    quiet: opts.quiet ?? true,
  });
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const pluginSdkDir = opts.pluginSdkDir ?? resolve(repoRoot, 'packages', 'plugin-sdk');
  const lockPath = resolvePluginSdkWorkspaceBundleLockPath({ repoRoot, lockPath: opts.lockPath });
  const baseEnv = opts.env ?? process.env;
  const publicationMode = opts.publicationMode ?? 'live';
  const forceArtifactWorkspaceBuilds = publicationMode === 'artifact';
  const publishWithWorkspaceBundleLock = opts.withWorkspaceBundleLock ?? withWorkspaceBundleLock;
  const loadWorkspacesModule = opts.loadCliCommonWorkspacesModule ?? loadCliCommonWorkspacesModule;
  const ensureWorkspacePackagesBuiltByName = opts.ensureWorkspacePackagesBuiltByName
    ?? ensureWorkspacePackagesBuiltByNameDefault;

  return publishWithWorkspaceBundleLock(async ({ heldLockValue } = {}) => {
    const childBuildEnv = createWorkspaceChildBuildEnv({
      env: baseEnv,
      heldLockValue,
    });
    const {
      bundleWorkspacePackagesWithRuntimeDependencies,
      resolveWorkspaceBundlesFromPackageJson,
    } = await loadWorkspacesModule(
      repoRoot,
      childBuildEnv,
      ensureWorkspacePackagesBuiltByName,
      {
        force: forceArtifactWorkspaceBuilds,
        includeDevDependencies: false,
        quiet: true,
      },
    );

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: pluginSdkDir,
    });
    await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      [...new Set(bundles.map((bundle) => String(bundle?.packageName ?? bundle?.name ?? '').trim()).filter(Boolean))],
      {
        quiet: true,
        env: childBuildEnv,
        includeDevDependencies: false,
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
    timeoutMs: 240_000,
    pollIntervalMs: 250,
    staleAfterMs: 240_000,
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    if (process.argv.slice(2).includes('--declarations')) {
      await preparePluginSdkWorkspacePrerequisites();
    } else {
      await bundleWorkspaceDeps({
        publicationMode: resolveWorkspaceBundlePublicationMode({
          argv: process.argv.slice(2),
          env: process.env,
        }),
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
