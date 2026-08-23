import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot } from './vendoredWorkspaceDeclarations.mjs';
import { ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault } from '../../../apps/stack/scripts/utils/proc/pm.mjs';
import { bundleWorkspacePackageDependencies } from '../../../scripts/workspaces/bundleWorkspacePackageDependencies.mjs';
import { WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  resolveWorkspaceBundleLockPath,
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
  return await bundleWorkspacePackageDependencies({
    ...opts,
    repoRoot,
    hostPackageDir: pluginSdkDir,
    lockPath,
    quiet: true,
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
