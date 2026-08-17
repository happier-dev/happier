import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot } from './vendoredWorkspaceDeclarations.mjs';
import { ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault } from '../../../apps/stack/scripts/utils/proc/pm.mjs';
import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import {
  createWorkspaceChildBuildEnv,
  WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR,
} from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { loadCliCommonWorkspacesModule } from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolvePluginSdkWorkspaceBundleLockPath({ repoRoot, lockPath = '' }) {
  const explicitLockPath = String(lockPath ?? '').trim();
  return explicitLockPath || resolveWorkspaceBundleLockPath(repoRoot);
}

function pluginSdkRepoRoot() {
  return findRepoRoot(__dirname) ?? resolve(__dirname, '..', '..', '..');
}

export async function preparePluginSdkWorkspacePrerequisites(opts = {}) {
  const repoRoot = opts.repoRoot ?? pluginSdkRepoRoot();
  const pluginSdkDir = opts.pluginSdkDir ?? resolve(repoRoot, 'packages', 'plugin-sdk');
  const env = opts.env ?? process.env;
  if (env?.[WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR] === '1') {
    return {
      ok: true,
      built: [],
      skipped: ['canonical-package-build'],
    };
  }
  const ensureWorkspacePackagesBuiltForComponent = opts.ensureWorkspacePackagesBuiltForComponent
    ?? ensureWorkspacePackagesBuiltForComponentDefault;
  return await ensureWorkspacePackagesBuiltForComponent(pluginSdkDir, {
    env,
    quiet: opts.quiet ?? true,
  });
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? pluginSdkRepoRoot();
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
        publicationMode,
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
