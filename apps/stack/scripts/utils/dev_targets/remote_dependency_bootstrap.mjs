import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolvePnpmCommandInvocation } from '../../../../../scripts/workspaces/execPnpmCommand.mjs';
import { run } from '../proc/proc.mjs';
import { resolveRemoteValidationPreparationEnv } from './validation_env.mjs';
import { adoptDependencyInstallation, assertDependenciesReady, inspectDependencyRefresh, isDependencyRefreshDisabled, withDependencyConsumption, withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { ensureUiPostinstallOutputs } from '../proc/ui_postinstall.mjs';
import { resolvePackageManagerCachePaths } from '../proc/package_manager_cache.mjs';
import { isYarnWorkspace } from '../proc/workspace_package_manifests.mjs';

export const REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS = [
  'install',
  '--prod=false',
  '--ignore-scripts',
  '--frozen-lockfile',
];

function resolveInitialInstallEnv(env) {
  const resolved = {
    ...(env ?? process.env),
    NODE_ENV: 'development',
    pnpm_config_production: 'false',
    npm_config_production: 'false',
    NPM_CONFIG_PRODUCTION: 'false',
  };
  const cacheBaseDir = String(resolved.HAPPIER_STACK_PM_CACHE_BASE_DIR ?? '').trim();
  if (cacheBaseDir) {
    for (const [key, path] of Object.entries(resolvePackageManagerCachePaths(cacheBaseDir))) resolved[key] ||= path;
  }
  return resolved;
}

async function installInitialDependencies({ repoDir, env, stdio = 'inherit' }) {
  const installEnv = resolveInitialInstallEnv(env);
  for (const path of [
    installEnv.XDG_CACHE_HOME,
    installEnv.pnpm_config_store_dir,
    installEnv.pnpm_config_cache_dir,
    installEnv.npm_config_cache,
  ]) {
    if (path) await mkdir(path, { recursive: true });
  }
  const invocation = resolvePnpmCommandInvocation(REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS, { preferPath: true });
  await run(invocation.command, invocation.args, {
    cwd: repoDir,
    env: installEnv,
    stdio,
    captureFailureDiagnostic: true,
  });
}

async function prepareInitialUiOutputs({ repoDir, env, force, stdio = 'inherit', quiet = false }) {
  const installEnv = resolveInitialInstallEnv(env);
  const runPnpm = async (args, postinstallEnv = installEnv) => {
    const invocation = resolvePnpmCommandInvocation(args, { preferPath: true });
    await run(invocation.command, invocation.args, {
      cwd: repoDir, env: postinstallEnv, stdio, captureFailureDiagnostic: true,
    });
  };
  await ensureUiPostinstallOutputs(join(repoDir, 'apps', 'ui'), repoDir, {
    force, env: installEnv, quiet,
    runPostinstall: async (postinstallEnv) => runPnpm(['--filter', '@happier-dev/app', 'run', '--silent', 'postinstall:real'], postinstallEnv),
    restoreDependencies: async () => runPnpm(['install', '--force', ...REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS.slice(1)]),
  });
}

// A provisioner that already ran the canonical frozen install with lifecycle
// scripts (CI's prepare job) records that installed tree's admission here,
// through the same refresh owner and mutation lock, without reinstalling.
// Later local validation then proves freshness against the recorded inputs.
export async function adoptInstalledDependencies({
  repoDir = resolve(process.cwd()),
  env = process.env,
} = {}) {
  if (!existsSync(join(repoDir, 'node_modules'))) {
    throw new Error(`[local] cannot adopt dependencies at ${repoDir}: node_modules is missing`);
  }
  return await adoptDependencyInstallation(
    {
      installDir: repoDir,
      componentDir: join(repoDir, 'apps', 'stack'),
      env,
      onDependenciesReady: async ({ env: readyEnv }) => {
        await prepareInitialUiOutputs({ repoDir, env: readyEnv, force: false });
        const { ensureServerGeneratedProviderOutputs } = await import('../proc/pm.mjs');
        await ensureServerGeneratedProviderOutputs(join(repoDir, 'apps', 'server'), repoDir, { env: readyEnv });
      },
    },
  );
}

export async function bootstrapRemoteDependencies({
  repoDir = resolve(process.cwd()),
  validationKind = 'runtime',
  toolsOnly = false,
  componentRelativeDir = '.',
  executionPlacement = 'local',
  defaultBuildMode = validationKind === 'runtime' ? 'source-dev' : 'strict',
  env = process.env,
  signal,
  packageExists = existsSync,
  installInitialDependencies: installInitialDependenciesImpl = installInitialDependencies,
  withDependencyRefresh: withDependencyRefreshImpl = withDependencyRefresh,
  loadWorkspaceBuildOwner = async () => await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs'),
  loadDependencyOwner = async () => await import('../proc/pm.mjs'),
} = {}) {
  // Runtime preparation emits executable prerequisites. Semantic checking is
  // owned by explicit strict/publication callers and the separate check lane.
  env = resolveRemoteValidationPreparationEnv(env, validationKind, defaultBuildMode);
  const componentDir = join(repoDir, 'apps', 'stack');
  const componentPath = posix.normalize(String(componentRelativeDir).replaceAll('\\', '/'));
  const sourceToolsOnly = toolsOnly || validationKind === 'source-test' || validationKind === 'typecheck';
  // Only an affirmative worker placement permits dependency mutation.
  if (executionPlacement !== 'remote') {
    await assertDependenciesReady({ installDir: repoDir, componentDir, env });
    if (!sourceToolsOnly && /^apps\/stack(?:\/|$)/u.test(componentPath)) {
      const { ensureWorkspacePackagesBuiltForComponent } = await loadDependencyOwner();
      await ensureWorkspacePackagesBuiltForComponent(componentDir, { env });
    }
    return;
  }
  let refreshed = false;
  const installAndPrepare = async ({ env: installEnv = env } = {}) => {
    await installInitialDependenciesImpl({ repoDir, env: installEnv });
    if (String(installEnv.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1' && !isYarnWorkspace(repoDir)) {
      const { ensureServerGeneratedProviderOutputs } = await import('../proc/pm.mjs');
      await ensureServerGeneratedProviderOutputs(join(repoDir, 'apps', 'server'), repoDir, { env: installEnv });
    }
    refreshed = true;
  };
  // Every role reads the same installed tree. Complete the canonical UI
  // postinstall under its mutation lock, including warm trees with lost patches.
  // A healthy warm tree is inspected without rewriting dependency bytes.
  const onDependenciesReady = async ({ env: readyEnv = env } = {}) => {
    await prepareInitialUiOutputs({ repoDir, env: readyEnv, force: refreshed });
    const { ensureServerGeneratedProviderOutputs } = await import('../proc/pm.mjs');
    await ensureServerGeneratedProviderOutputs(join(repoDir, 'apps', 'server'), repoDir, { env: readyEnv });
  };
  if (sourceToolsOnly) {
    // Warm validation is a reader. Queuing a writer for every readiness check
    // withdraws admission repeatedly and starves finite consumers behind work
    // that never installs anything. Recheck under the existing shared custody;
    // release it before requesting an actual installation or output repair.
    try {
      await withDependencyConsumption({ installDir: repoDir, env, signal }, async readEnv => {
        await assertDependenciesReady({ installDir: repoDir, componentDir, env: readEnv });
      });
      return { refreshed: false, reason: 'up-to-date' };
    } catch (error) {
      if (!['HAPPIER_DEPENDENCIES_NEED_REFRESH', 'HAPPIER_DEPENDENCY_REFRESH_FAILED'].includes(error?.code)
        || isDependencyRefreshDisabled(env)) throw error;
    }
    // Source validation does not consume the Stack owner's compiled closure.
    // Typecheck compilers read published declarations and prepare their own
    // project declarations without acquiring workspace publication leases.
    // The readiness verifier and postinstall tools resolve source directly;
    // retain patched dependency preparation without publishing workspace dist.
    return await withDependencyRefreshImpl(
      { installDir: repoDir, componentDir, env, onDependenciesReady,
        waitForPendingStart: true, signal },
      installAndPrepare,
    );
  }
  const dependencyOwnerEntrypoints = ['workspaces', 'process'].map((domain) => join(
    repoDir,
    'packages',
    'cli-common',
    'dist',
    domain,
    'index.js',
  ));
  const dependencyOwnerReady = dependencyOwnerEntrypoints.every((entrypoint) => packageExists(entrypoint));
  if (!dependencyOwnerReady) {
    await withDependencyRefreshImpl(
      { installDir: repoDir, componentDir, env, onDependenciesReady },
      installAndPrepare,
    );
    const { ensureWorkspacePackagesBuiltByName } = await loadWorkspaceBuildOwner();
    await ensureWorkspacePackagesBuiltByName(
      repoDir,
      ['@happier-dev/cli-common'],
      { env, includeDevDependencies: false },
    );
  }

  const {
    ensureDepsInstalled,
    ensureWorkspacePackagesBuiltForComponent,
  } = await loadDependencyOwner();
  await ensureDepsInstalled(
    componentDir,
    'remote Happier workspace',
    { env },
  );
  const { ensureServerGeneratedProviderOutputs } = await import('../proc/pm.mjs');
  await ensureServerGeneratedProviderOutputs(join(repoDir, 'apps', 'server'), repoDir, { env });
  // The launcher needs its dependency owner, while only Stack commands consume
  // Stack's emitted workspace closure. Other components prepare their own outputs.
  if (/^apps\/stack(?:\/|$)/u.test(componentPath)) {
    if (typeof ensureWorkspacePackagesBuiltForComponent !== 'function') {
      throw new Error('Remote Happier workspace dependency owner does not expose component workspace preparation');
    }
    await ensureWorkspacePackagesBuiltForComponent(componentDir, { env });
  }
}

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  if (process.argv.includes('--adopt-installed')) {
    const adoptRepo = process.argv.slice(2).find(value => value.startsWith('--repo-dir='));
    await adoptInstalledDependencies(adoptRepo ? { repoDir: resolve(adoptRepo.slice('--repo-dir='.length)) } : {});
    process.exit(0);
  }
  const kind = process.argv.slice(2).find(value => value.startsWith('--validation-kind='));
  const component = process.argv.slice(2).find(value => value.startsWith('--component-relative-dir='));
  const repo = process.argv.slice(2).find(value => value.startsWith('--repo-dir='));
  const placement = process.argv.slice(2).find(value => value.startsWith('--execution-placement='));
  const buildMode = process.argv.slice(2).find(value => value.startsWith('--default-build-mode='));
  if (placement === '--execution-placement=remote') {
    const repoDir = repo ? resolve(repo.slice('--repo-dir='.length)) : process.cwd();
    const manifest = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8'));
    if (isYarnWorkspace(manifest)) {
      // The predecessor's executable owns Yarn installation and its admission
      // format. The executor retains placement; it does not replace that owner.
      const sourceBootstrap = join(repoDir, 'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs');
      if (sourceBootstrap === fileURLToPath(import.meta.url)) {
        throw new Error('Yarn predecessor bootstrap requires its source-owned entrypoint');
      }
      try {
        execFileSync(process.execPath, [sourceBootstrap, ...process.argv.slice(2)], {
          cwd: repoDir, env: process.env, stdio: 'inherit',
        });
      } catch (error) {
        if (typeof error.status === 'number') process.exit(error.status);
        throw error;
      }
      process.exit(0);
    }
    // Cold bootstrap must load only dependency-free process boundaries. The
    // containing SSH process group owns cancellation of this synchronous child.
    execFileSync(process.execPath, [fileURLToPath(new URL('../../../../../scripts/ci/setup-pnpm.mjs', import.meta.url)), repoDir], {
      cwd: repoDir, env: resolveInitialInstallEnv(process.env), stdio: 'inherit',
    });
  }
  await bootstrapRemoteDependencies({
    ...(repo ? { repoDir: resolve(repo.slice('--repo-dir='.length)) } : {}),
    toolsOnly: process.argv.includes('--tools-only'),
    validationKind: kind?.slice('--validation-kind='.length) ?? 'runtime',
    componentRelativeDir: component?.slice('--component-relative-dir='.length) ?? '.',
    executionPlacement: placement?.slice('--execution-placement='.length) ?? 'local',
    ...(buildMode ? { defaultBuildMode: buildMode.slice('--default-build-mode='.length) } : {}),
  });
}
