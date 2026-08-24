import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
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

/**
 * Makes the physical workspace package graph resolved by Plugin SDK source
 * tooling current. Building the canonical workspace outputs alone is not
 * sufficient: this package intentionally resolves the private physical copies
 * under its own node_modules while compiling and projecting its public API.
 */
export async function preparePluginSdkWorkspaceDeclarations(opts = {}) {
  const repoRoot = opts.repoRoot ?? pluginSdkRepoRoot();
  const pluginSdkDir = opts.pluginSdkDir ?? resolve(repoRoot, 'packages', 'plugin-sdk');
  const bundleWorkspaceDepsImpl = opts.bundleWorkspaceDepsImpl ?? bundleWorkspaceDeps;
  return await bundleWorkspaceDepsImpl({
    repoRoot,
    pluginSdkDir,
    env: opts.env ?? process.env,
    publicationMode: 'live',
    consumePreparedWorkspace: opts.consumePreparedWorkspace,
  });
}

export async function runPluginSdkPreparedScript(scriptName, opts = {}) {
  const env = opts.env ?? process.env;
  const pluginSdkDir = opts.pluginSdkDir ?? resolve(opts.repoRoot ?? pluginSdkRepoRoot(), 'packages', 'plugin-sdk');
  const npmExecPath = String(env.npm_execpath ?? '').trim();
  const command = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'yarn.cmd' : 'yarn');
  const args = npmExecPath
    ? [npmExecPath, 'run', '-s', scriptName]
    : ['run', '-s', scriptName];
  const spawnImpl = opts.spawnImpl ?? spawn;
  await new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(command, args, {
      cwd: pluginSdkDir,
      env,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `Plugin SDK prepared script ${scriptName} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`,
      ));
    });
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    const preparedScript = process.argv.slice(2)
      .find((arg) => arg.startsWith('--run-script='))
      ?.slice('--run-script='.length);
    if (process.argv.slice(2).includes('--declarations')) {
      await preparePluginSdkWorkspaceDeclarations({
        ...(preparedScript
          ? {
              consumePreparedWorkspace: async ({ preparedWorkspaceEnv }) => {
                await runPluginSdkPreparedScript(preparedScript, { env: preparedWorkspaceEnv });
              },
            }
          : {}),
      });
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
