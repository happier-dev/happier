import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildWindowsCmdShimInvocation,
  execYarn as execYarnCommand,
  resolveYarnInvocation as resolveYarnCommandInvocation,
} from '../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { syncBundledWorkspacePackages } from '../../../scripts/workspaces/syncBundledWorkspacePackages.mjs';
import { resolveBundledWorkspaceDependencyBuildOrder } from '../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function withBuildSharedDepsLock(fn, options = {}) {
  const lockPath = options.lockPath ?? DEFAULT_BUILD_LOCK_PATH;
  return await withWorkspaceBundleLock(fn, { ...options, lockPath });
}

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
  // Fallback for older layouts (repoRoot/apps/cli/scripts).
  return resolve(startDir, '..', '..', '..');
}

const repoRoot = findRepoRoot(__dirname);
const DEFAULT_BUILD_LOCK_PATH = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

export function execYarn(args, options = {}) {
  return execYarnCommand(args, options);
}

export function resolveYarnInvocation(npmExecPath = process.env.npm_execpath, options = {}) {
  return resolveYarnCommandInvocation(npmExecPath, options);
}

async function loadCliCommonWorkspacesModule() {
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');

  if (!existsSync(modulePath)) {
    for (const workspaceName of resolveCliBundledWorkspacePackageNames()) {
      execYarn(['-s', 'workspace', `@happier-dev/${workspaceName}`, 'build'], { cwd: repoRoot, stdio: 'inherit' });
      if (workspaceName === 'cli-common' && existsSync(modulePath)) {
        break;
      }
    }
  }

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await import(pathToFileURL(modulePath).href);
}

const {
  bundleInstalledPackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} = await loadCliCommonWorkspacesModule();
const CLI_BUNDLED_HOST_APPS = ['cli'];
const PLUGINS_WORKSPACE_PREFIX = 'plugins-';

export function resolveBundledWorkspacePackageDir({ repoRoot, workspaceName }) {
  const name = String(workspaceName ?? '').trim();
  if (!name) return '';

  if (name.startsWith(PLUGINS_WORKSPACE_PREFIX)) {
    const pluginId = name.slice(PLUGINS_WORKSPACE_PREFIX.length);
    if (pluginId) {
      return resolve(repoRoot, 'packages', 'plugins', pluginId);
    }
  }

  return resolve(repoRoot, 'packages', name);
}

export function resolveBundledWorkspaceTsconfigPath({ repoRoot, workspaceName }) {
  const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
  if (!packageDir) return '';
  return resolve(packageDir, 'tsconfig.json');
}

function resolveCliBundledWorkspacePackageNames({ exists = existsSync } = {}) {
  return resolveBundledWorkspaceDependencyBuildOrder({
    repoRoot,
    hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
    existsSync: exists,
  }).filter((name) => exists(resolveBundledWorkspaceTsconfigPath({ repoRoot, workspaceName: name })));
}

export function resolveTscBin({
  exists,
  platform,
  processExecPath,
  requireResolve,
  workspaceDir,
  repoRoot: repoRootArg,
} = {}) {
  const resolvedRepoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : repoRoot;
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot: resolvedRepoRoot,
    workspaceDir: workspaceDir ?? resolve(resolvedRepoRoot, 'apps', 'cli'),
    processExecPath: processExecPath ?? process.execPath,
    requireResolve,
    existsSync: exists ?? existsSync,
    platform: platform ?? process.platform,
  });

  if (invocation.command === (processExecPath ?? process.execPath) && invocation.argsPrefix.length > 0) {
    return invocation.argsPrefix[0];
  }

  return invocation.command;
}

const tscBin = resolveTscBin();

export function runTsc(tsconfigPath, opts) {
  const exec = opts?.execFileSync ?? execFileSync;
  const tsc = opts?.tscBin ?? tscBin;
  const platform = opts?.platform ?? process.platform;
  try {
    if (platform === 'win32' && (tsc.endsWith('.cmd') || tsc.endsWith('.bat'))) {
      const wrapped = buildWindowsCmdShimInvocation(tsc, ['-p', tsconfigPath], {
        comspec: opts?.comspec,
      });
      exec(wrapped.command, wrapped.args, {
        stdio: 'inherit',
        windowsVerbatimArguments: wrapped.windowsVerbatimArguments,
      });
    } else {
      // Execute tsc via Node to avoid `.bin/*` symlink spawn issues and shebang portability quirks.
      exec(process.execPath, [tsc, '-p', tsconfigPath], { stdio: 'inherit' });
    }
  } catch (error) {
    const suffix = tsconfigPath ? ` (${tsconfigPath})` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compile shared workspace deps${suffix}: ${message}`);
  }
}

export function syncBundledWorkspaceDist(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  syncBundledWorkspacePackages({
    repoRoot,
    hostApps: Array.isArray(opts.bundledHostApps) && opts.bundledHostApps.length > 0 ? opts.bundledHostApps : CLI_BUNDLED_HOST_APPS,
    existsSync: opts.existsSync,
    cpSync: opts.cpSync,
    mkdirSync: opts.mkdirSync,
    rmSync: opts.rmSync,
    readFileSync: opts.readFileSync,
    writeFileSync: opts.writeFileSync,
  });
}

export function syncCliRuntimeDependencies(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const cliPackageJsonPath = resolve(repoRoot, 'apps', 'cli', 'package.json');
  const cliNodeModulesDir = resolve(repoRoot, 'apps', 'cli', 'node_modules');
  const cliRequire = createRequire(pathToFileURL(cliPackageJsonPath).href);
  const resolvedTweetnaclEntry = cliRequire.resolve('tweetnacl');
  const resolvedTweetnaclDir = dirname(resolvedTweetnaclEntry);

  if (resolvedTweetnaclDir === resolve(cliNodeModulesDir, 'tweetnacl')) {
    return;
  }

  bundleInstalledPackageWithRuntimeDependencies({
    packageName: 'tweetnacl',
    resolveFromPackageJsonPath: cliPackageJsonPath,
    destNodeModulesDir: cliNodeModulesDir,
  });
}

export function syncBundledWorkspaceRuntimeDependencies(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
  });

  for (const bundle of bundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: resolve(bundle.srcDir, 'package.json'),
      destPackageDir: bundle.destDir,
    });
  }
}

export function main() {
  return withBuildSharedDepsLock(async () => {
    const bundledWorkspaceNames = resolveCliBundledWorkspacePackageNames();
    for (const name of bundledWorkspaceNames) {
      runTsc(resolveBundledWorkspaceTsconfigPath({ repoRoot, workspaceName: name }));
    }

    const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    if (!existsSync(protocolDist)) {
      throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
    }

    // If the CLI currently has bundled workspace deps under apps/cli/node_modules,
    // keep their dist outputs in sync so local builds/tests do not consume stale artifacts.
    syncBundledWorkspaceDist({ repoRoot });
    syncBundledWorkspaceRuntimeDependencies({ repoRoot });
    syncCliRuntimeDependencies({ repoRoot });
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();

if (invokedAsMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
