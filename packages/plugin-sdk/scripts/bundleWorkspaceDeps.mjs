import { dirname, relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { getForegroundCommandResult, spawnForegroundCommand } from '../../../apps/stack/scripts/utils/proc/proc.mjs';
import { fileURLToPath } from 'node:url';
import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs';

import { captureVendoredWorkspaceDeclarationIdentity, findRepoRoot, VENDORED_WORKSPACE_DECLARATION_IDENTITY_ENV_VAR } from './vendoredWorkspaceDeclarations.mjs';
import { ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault } from '../../../apps/stack/scripts/utils/proc/pm.mjs';
import { bundleWorkspacePackageDependencies } from '../../../scripts/workspaces/bundleWorkspacePackageDependencies.mjs';
import { WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';
import { resolveWorkspacePackageBuildAdmissionClass } from '../../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs';
import { runWorkspaceBuildAdmission } from '../../../apps/stack/scripts/utils/proc/workspace_build_admission.mjs';
import { requiresTypeScriptAdmission } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import {
  resolveWorkspaceBundleLockPath,
  callerHoldsWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolvePluginSdkWorkspaceBundleLockPath({ repoRoot, lockPath = '', env = process.env }) {
  const explicitLockPath = String(lockPath ?? '').trim();
  return explicitLockPath || resolveWorkspaceBundleLockPath(env.HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR || repoRoot);
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
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? pluginSdkRepoRoot();
  const pluginSdkDir = opts.pluginSdkDir ?? resolve(repoRoot, 'packages', 'plugin-sdk');
  const env = opts.env ?? process.env;
  const lockPath = resolvePluginSdkWorkspaceBundleLockPath({ repoRoot, lockPath: opts.lockPath, env });
  return await bundleWorkspacePackageDependencies({
    ...opts,
    repoRoot,
    env,
    hostPackageDir: pluginSdkDir,
    lockPath,
    quiet: true,
    ...(opts.consumePreparedWorkspace ? {
      consumePreparedWorkspace: async (prepared) => {
        // Bind the reader to the copy just admitted under the existing bundle
        // lease. New workspace output belongs to the next demand; the physical
        // copy and the installed-dependency fence remain authoritative here.
        const identity = await captureVendoredWorkspaceDeclarationIdentity({ packageRoot: pluginSdkDir });
        return await opts.consumePreparedWorkspace({
          ...prepared,
          preparedWorkspaceEnv: {
            ...prepared.preparedWorkspaceEnv,
            [VENDORED_WORKSPACE_DECLARATION_IDENTITY_ENV_VAR]: identity,
          },
        });
      },
    } : {}),
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
    pruneStale: true,
    consumePreparedWorkspace: opts.consumePreparedWorkspace,
    ...(opts.lockPath ? { lockPath: opts.lockPath } : {}),
  });
}

async function preparedScriptPublicationPaths({ repoRoot, pluginSdkDir, env }) {
  const packageJson = JSON.parse(await readFile(resolve(pluginSdkDir, 'package.json'), 'utf8'));
  // Captured compilation uses the producer's exact publication authority; the
  // capture remains only the source/tooling cwd and never gains another owner.
  const publicationRoot = env.HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR || repoRoot;
  const publicationPackageDir = resolve(publicationRoot, relative(repoRoot, pluginSdkDir));
  return { packageJson, locks: [resolvePluginSdkWorkspaceBundleLockPath({ repoRoot, env }),
    resolveWorkspacePackageBuildLockPath(publicationPackageDir, packageJson)] };
}

async function runPreparedWorkspaceWorker({ repoRoot, pluginSdkDir, scriptName, signal }) {
  const env = process.env;
  const { locks } = await preparedScriptPublicationPaths({ repoRoot, pluginSdkDir, env });
  const leases = JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]');
  const values = [env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, ...(Array.isArray(leases) ? leases : [])];
  if (locks.some(path => !values.some(value => callerHoldsWorkspaceBundleLock(path, value)))) {
    throw new Error('Plugin SDK prepared worker requires its exact inherited publication leases');
  }
  await preparePluginSdkWorkspaceDeclarations({ repoRoot, pluginSdkDir, env, lockPath: locks[0],
    consumePreparedWorkspace: ({ preparedWorkspaceEnv }) => runPluginSdkPreparedScript(scriptName,
      { pluginSdkDir, env: preparedWorkspaceEnv, signal }),
  });
}

async function runPreparedWorkspace(scriptName, { signal } = {}) {
  const repoRoot = pluginSdkRepoRoot();
  const pluginSdkDir = resolve(__dirname, '..');
  await preparePluginSdkWorkspacePrerequisites({ repoRoot, pluginSdkDir, env: process.env, signal });
  const env = { ...process.env, [WORKSPACE_PACKAGE_PREREQUISITES_READY_ENV_VAR]: '1' };
  const { packageJson, locks } = await preparedScriptPublicationPaths({ repoRoot, pluginSdkDir, env });
  const result = await runWorkspaceBuildAdmission({ command: process.execPath,
    args: [fileURLToPath(import.meta.url), '--prepared-workspace-worker', JSON.stringify({ repoRoot, pluginSdkDir, scriptName })],
    locks: locks.map(path => ({ path })), cwd: pluginSdkDir, env, signal,
    dependencyInstallDir: env.HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR || repoRoot,
    admissionClass: await resolveWorkspacePackageBuildAdmissionClass({ packageJson, cwd: pluginSdkDir, env, scriptName, repoRoot }),
    admissionRequired: requiresTypeScriptAdmission({ env }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error(
    `Plugin SDK prepared script ${scriptName} failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.status}`}.`,
  );
}

export async function runPluginSdkPreparedScript(scriptName, opts = {}) {
  const env = opts.env ?? process.env;
  // SDK governance/publication has exhausted Node's default 4 GiB heap.
  // Own its 8 GiB budget here so every prepared child inherits it, including
  // workers whose executor does not forward the caller's NODE_OPTIONS.
  const childEnv = { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() };
  const pluginSdkDir = opts.pluginSdkDir ?? resolve(opts.repoRoot ?? pluginSdkRepoRoot(), 'packages', 'plugin-sdk');
  const invocation = resolvePnpmCommandInvocation(['--silent', 'run', scriptName], { npmExecPath: String(env.npm_execpath ?? '') });
  const spawnImpl = opts.spawnImpl ?? spawnForegroundCommand;
  await new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd: pluginSdkDir,
      env: childEnv,
      stdio: 'inherit',
      ownedProcessGroup: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    child.once('error', rejectRun);
    child.once('close', (nativeCode, nativeSignal) => {
      const { status: code, signal } = getForegroundCommandResult(child, nativeCode, nativeSignal);
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
  const args = process.argv.slice(2);
  const preparedScript = args.find(arg => arg.startsWith('--run-script='))?.slice('--run-script='.length);
  const preparedWorker = process.argv[2] === '--prepared-workspace-worker';
  const preparedTransaction = preparedWorker || (args.includes('--declarations') && Boolean(preparedScript));
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  if (preparedTransaction) for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupt);
  try {
    if (preparedWorker) {
      await runPreparedWorkspaceWorker({ ...JSON.parse(process.argv[3]), signal: cancellation.signal });
    } else {
      if (args.includes('--declarations')) {
        if (preparedScript) await runPreparedWorkspace(preparedScript, { signal: cancellation.signal });
        else await preparePluginSdkWorkspaceDeclarations();
      } else {
        await bundleWorkspaceDeps({
          publicationMode: resolveWorkspaceBundlePublicationMode({
            argv: process.argv.slice(2),
            env: process.env,
          }),
        });
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
  }
}
