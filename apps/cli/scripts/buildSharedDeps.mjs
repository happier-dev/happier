import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  execYarn as execYarnCommand,
  resolveYarnInvocation as resolveYarnCommandInvocation,
} from '../../../scripts/workspaces/execYarnCommand.mjs';
import { prepareTypeScriptProjectBuild } from '../../../scripts/workspaces/prepareTypeScriptProjectBuild.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import {
  syncBundledWorkspacePackages,
  vendorBundledPackageRuntimeDependenciesFallback,
} from '../../../scripts/workspaces/syncBundledWorkspacePackages.mjs';
import * as workspaceDependencyBuildOrder from '../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import {
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BUNDLED_HOST_APPS = ['cli'];
const PLUGINS_WORKSPACE_PREFIX = 'plugins-';
const SOURCE_DEV_SHARED_DEPS_STAMP_VERSION = 3;
const SOURCE_DEV_SHARED_DEPS_PROGRESS_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_PROGRESS';
const SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_MS';
const SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_MS';
const SOURCE_DEV_SHARED_DEPS_WORKSPACES_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACES';
const SOURCE_DEV_SHARED_DEPS_PROGRESS_VALUE = 'json-v1';
const SOURCE_DEV_SHARED_DEPS_PROGRESS_PREFIX = '[happier-source-dev-shared-deps-progress] ';

function resolveRepoRootOption(repoRootArg) {
  return typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
}

function readPositiveIntegerEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveSourceDevSharedDepsLockOptions(lockOptions = {}) {
  const lockTimeoutMs = readPositiveIntegerEnv(SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_ENV);
  return {
    ...(lockTimeoutMs ? { timeoutMs: lockTimeoutMs, staleAfterMs: lockTimeoutMs } : {}),
    ...lockOptions,
  };
}

function resolvePositiveIntegerOption(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveSourceDevWorkspaceBuildTimeoutMs(value) {
  return resolvePositiveIntegerOption(value) ?? readPositiveIntegerEnv(SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_ENV);
}

function createSourceDevSharedDepsProgressReporter(opts = {}) {
  const directReporter = typeof opts.reportProgress === 'function' ? opts.reportProgress : null;
  const emitToStderr = process.env[SOURCE_DEV_SHARED_DEPS_PROGRESS_ENV] === SOURCE_DEV_SHARED_DEPS_PROGRESS_VALUE;
  if (!directReporter && !emitToStderr) return null;

  const startedAtMs = Date.now();
  return (event) => {
    const payload = {
      ...event,
      elapsedMs: Date.now() - startedAtMs,
    };
    if (directReporter) {
      directReporter(payload);
    }
    if (emitToStderr) {
      process.stderr.write(`${SOURCE_DEV_SHARED_DEPS_PROGRESS_PREFIX}${JSON.stringify(payload)}\n`);
    }
  };
}

function reportSourceDevSharedDepsProgress(reportProgress, event) {
  reportProgress?.(event);
}

export async function withBuildSharedDepsLock(fn, options = {}) {
  const lockPath = options.lockPath ?? DEFAULT_BUILD_LOCK_PATH;
  return await withOptionalCliSharedDepsBuildLock(fn, {
    ...options,
    repoRoot: options.repoRoot ?? repoRoot,
    lockPath,
  });
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
const DEFAULT_BUILD_LOCK_PATH = resolveCliSharedDepsBuildLockPath(repoRoot);

export function execYarn(args, options = {}) {
  return execYarnCommand(args, options);
}

export function resolveYarnInvocation(npmExecPath = process.env.npm_execpath, options = {}) {
  return resolveYarnCommandInvocation(npmExecPath, options);
}

async function loadCliCommonWorkspacesModule(options = {}) {
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');

  if (!existsSync(modulePath) && options.buildIfMissing !== false) {
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

export function resolveCliBundledWorkspacePackageNames({ repoRoot: repoRootArg, exists = existsSync } = {}) {
  const resolvedRepoRoot = resolveRepoRootOption(repoRootArg);
  return workspaceDependencyBuildOrder.resolveBundledWorkspaceDependencyBuildOrder({
    repoRoot: resolvedRepoRoot,
    hostPackageDir: resolve(resolvedRepoRoot, 'apps', 'cli'),
    existsSync: exists,
  }).filter((name) => exists(resolveBundledWorkspaceTsconfigPath({ repoRoot: resolvedRepoRoot, workspaceName: name })));
}

export function resolveTscBin({
  processExecPath,
  requireResolve,
  readFileSyncImpl,
  workspaceDir,
  repoRoot: repoRootArg,
} = {}) {
  const resolvedRepoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : repoRoot;
  const invocation = resolveTypeScriptCliInvocation({
    repoRoot: resolvedRepoRoot,
    workspaceDir: workspaceDir ?? resolve(resolvedRepoRoot, 'apps', 'cli'),
    processExecPath: processExecPath ?? process.execPath,
    requireResolve,
    readFileSyncImpl,
  });

  if (invocation.command === (processExecPath ?? process.execPath) && invocation.argsPrefix.length > 0) {
    return invocation.argsPrefix[0];
  }

  return invocation.command;
}

const tscBin = resolveTscBin();

function readJsonFile(path, readFile = readFileSync) {
  return JSON.parse(readFile(path, 'utf8'));
}

function collectInternalRuntimeWorkspaceDepNames(rawPackageJson) {
  const out = [];
  for (const deps of [rawPackageJson?.dependencies, rawPackageJson?.optionalDependencies]) {
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) {
      if (typeof name === 'string' && name.startsWith('@happier-dev/')) {
        out.push(name);
      }
    }
  }
  return out;
}

function readBundledWorkspacePackageNames(rawPackageJson) {
  const bundledDependencies = Array.isArray(rawPackageJson?.bundledDependencies)
    ? rawPackageJson.bundledDependencies
    : Array.isArray(rawPackageJson?.bundleDependencies)
      ? rawPackageJson.bundleDependencies
      : [];

  return bundledDependencies.filter((value) => typeof value === 'string' && value.startsWith('@happier-dev/'));
}

function resolveWorkspaceSourceDirFallback({ repoRoot, packageName }) {
  const name = String(packageName ?? '').trim();
  const workspaceName = name.split('/').pop();
  if (!workspaceName) {
    throw new Error(`Unable to resolve workspace name from bundled dependency: ${name}`);
  }

  if (workspaceName.startsWith(PLUGINS_WORKSPACE_PREFIX)) {
    const pluginId = workspaceName.slice(PLUGINS_WORKSPACE_PREFIX.length);
    if (pluginId) return resolve(repoRoot, 'packages', 'plugins', pluginId);
  }

  return resolve(repoRoot, 'packages', workspaceName);
}

function resolveInternalWorkspacePackageNameClosureFallback({ repoRoot, packageNames, exists = existsSync, readFile = readFileSync }) {
  const visited = new Set();

  const visit = (packageName) => {
    const normalizedName = String(packageName ?? '').trim();
    if (!normalizedName.startsWith('@happier-dev/') || visited.has(normalizedName)) return;
    visited.add(normalizedName);

    const sourcePackageJsonPath = resolve(resolveWorkspaceSourceDirFallback({ repoRoot, packageName: normalizedName }), 'package.json');
    if (!exists(sourcePackageJsonPath)) return;

    const sourcePackageJson = readJsonFile(sourcePackageJsonPath, readFile);
    for (const dependencyName of collectInternalRuntimeWorkspaceDepNames(sourcePackageJson)) {
      visit(dependencyName);
    }
  };

  for (const packageName of packageNames) {
    visit(packageName);
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}

function resolveWorkspaceBundlesFromPackageJsonFallback({ repoRoot, hostPackageDir, exists = existsSync, readFile = readFileSync }) {
  const hostPackageJsonPath = resolve(hostPackageDir, 'package.json');
  if (!exists(hostPackageJsonPath)) {
    throw new Error(`Missing host package.json: ${hostPackageJsonPath}`);
  }

  const hostPackageJson = readJsonFile(hostPackageJsonPath, readFile);
  const bundledWorkspaceNames = readBundledWorkspacePackageNames(hostPackageJson);
  const bundledWorkspaceNameSet = new Set(bundledWorkspaceNames);
  const bundledWorkspaceClosureNames = resolveInternalWorkspacePackageNameClosureFallback({
    repoRoot,
    packageNames: bundledWorkspaceNames,
    exists,
    readFile,
  });
  const missingClosureNames = bundledWorkspaceClosureNames.filter((packageName) => !bundledWorkspaceNameSet.has(packageName));
  if (missingClosureNames.length > 0) {
    throw new Error(
      [
        `Missing bundled internal workspace dependencies in ${hostPackageJsonPath}:`,
        ...missingClosureNames.map((packageName) => `- ${packageName}`),
      ].join('\n'),
    );
  }

  return bundledWorkspaceClosureNames.map((packageName) => ({
    packageName,
    srcDir: resolveWorkspaceSourceDirFallback({ repoRoot, packageName }),
    destDir: resolve(hostPackageDir, 'node_modules', ...packageName.split('/')),
  }));
}

function resolveInstalledPackage({ require, packageName }) {
  const searchPaths = require.resolve.paths(packageName) ?? [];
  let aliasInstalledPackage = null;

  for (const searchPath of searchPaths) {
    const packageJsonPath = resolve(searchPath, ...packageName.split('/'), 'package.json');
    if (!existsSync(packageJsonPath)) continue;

    const packageJson = readJsonFile(packageJsonPath);
    const installedPackage = {
      packageDir: dirname(packageJsonPath),
      packageJsonPath,
    };
    if (packageJson?.name === packageName) {
      return installedPackage;
    }
    aliasInstalledPackage ??= installedPackage;
  }

  if (aliasInstalledPackage) {
    return aliasInstalledPackage;
  }

  let resolvedEntry = '';
  try {
    resolvedEntry = require.resolve(`${packageName}/package.json`);
  } catch {
    resolvedEntry = require.resolve(packageName);
  }

  let dir = dirname(resolvedEntry);
  for (let i = 0; i < 50; i++) {
    const packageJsonPath = resolve(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (packageJson?.name === packageName) {
        return {
          packageDir: dir,
          packageJsonPath,
        };
      }
    }

    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Failed to locate installed package.json for ${packageName} (resolved: ${resolvedEntry})`);
}

function bundleInstalledPackageWithRuntimeDependenciesFallback({ packageName, resolveFromPackageJsonPath, destNodeModulesDir }) {
  const require = createRequire(pathToFileURL(resolveFromPackageJsonPath).href);
  const resolved = resolveInstalledPackage({ require, packageName });
  const destPackageDir = resolve(destNodeModulesDir, ...packageName.split('/'));

  mkdirSync(destNodeModulesDir, { recursive: true });
  rmSync(destPackageDir, { recursive: true, force: true });
  cpSync(resolved.packageDir, destPackageDir, { recursive: true, dereference: true });
  vendorBundledPackageRuntimeDependenciesFallback({
    srcPackageJsonPath: resolved.packageJsonPath,
    resolveFromPackageJsonPath: resolved.packageJsonPath,
    destPackageDir,
  });
}

export function runTsc(tsconfigPath, opts) {
  const exec = opts?.execFileSync ?? execFileSync;
  const tsc = opts?.tscBin ?? tscBin;
  const timeoutMs = resolvePositiveIntegerOption(opts?.timeoutMs);
  const execOptions = timeoutMs ? { stdio: 'inherit', timeout: timeoutMs } : { stdio: 'inherit' };
  try {
    prepareTypeScriptProjectBuild({
      tsconfigPath,
      existsSync: opts?.existsSync,
      readFileSync: opts?.readFileSync,
      rmSync: opts?.rmSync,
    });
    exec(process.execPath, [tsc, '-p', tsconfigPath], execOptions);
  } catch (error) {
    const suffix = tsconfigPath ? ` (${tsconfigPath})` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compile shared workspace deps${suffix}: ${message}`);
  }
}

export function syncBundledWorkspaceDist(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(opts.workspaceNames);
  syncBundledWorkspacePackages({
    repoRoot,
    hostApps: Array.isArray(opts.bundledHostApps) && opts.bundledHostApps.length > 0 ? opts.bundledHostApps : CLI_BUNDLED_HOST_APPS,
    ...(workspaceNames.length > 0 ? { packages: workspaceNames } : {}),
    replaceExisting: opts.replaceExisting,
    syncId: opts.syncId,
    staleSwapDirAgeMs: opts.staleSwapDirAgeMs,
    nowMs: opts.nowMs,
    isPidAlive: opts.isPidAlive,
    existsSync: opts.existsSync,
    cpSync: opts.cpSync,
    mkdirSync: opts.mkdirSync,
    rmSync: opts.rmSync,
    readFileSync: opts.readFileSync,
    writeFileSync: opts.writeFileSync,
  });
}

export function syncWorkspaceBundledDependenciesForBuild(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const workspaceName = normalizeSourceDevSharedDepsWorkspaceName(opts.workspaceName);
  if (!workspaceName) return;
  const hostPackageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
  syncBundledWorkspacePackages({
    repoRoot,
    hostPackageDirs: [hostPackageDir],
    replaceExisting: true,
    syncId: opts.syncId,
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
  const bundleInstalledPackageWithRuntimeDependencies =
    typeof opts.bundleInstalledPackageWithRuntimeDependencies === 'function'
      ? opts.bundleInstalledPackageWithRuntimeDependencies
      : bundleInstalledPackageWithRuntimeDependenciesFallback;
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
  const resolveWorkspaceBundlesFromPackageJson =
    typeof opts.resolveWorkspaceBundlesFromPackageJson === 'function'
      ? opts.resolveWorkspaceBundlesFromPackageJson
      : (params) => resolveWorkspaceBundlesFromPackageJsonFallback({
        ...params,
        exists: opts.existsSync,
        readFile: opts.readFileSync,
      });
  const vendorBundledPackageRuntimeDependencies =
    typeof opts.vendorBundledPackageRuntimeDependencies === 'function'
      ? opts.vendorBundledPackageRuntimeDependencies
      : vendorBundledPackageRuntimeDependenciesFallback;
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
  });
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(opts.workspaceNames);
  const targetPackageNames = workspaceNames.length > 0
    ? new Set(workspaceNames.map((workspaceName) => `@happier-dev/${workspaceName}`))
    : null;

  for (const bundle of targetPackageNames
    ? bundles.filter((candidate) => targetPackageNames.has(candidate.packageName))
    : bundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: resolve(bundle.srcDir, 'package.json'),
      destPackageDir: bundle.destDir,
    });
  }
}

function normalizeSourceDevSharedDepsWorkspaceName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('@happier-dev/')) {
    return raw.slice('@happier-dev/'.length).trim();
  }
  return raw;
}

function normalizeSourceDevSharedDepsWorkspaceNames(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const workspaceName = normalizeSourceDevSharedDepsWorkspaceName(value);
    if (!workspaceName || seen.has(workspaceName)) continue;
    seen.add(workspaceName);
    result.push(workspaceName);
  }
  return result;
}

export function readSourceDevSharedDepsWorkspaceNamesFromEnv(env = process.env) {
  const raw = env?.[SOURCE_DEV_SHARED_DEPS_WORKSPACES_ENV];
  if (typeof raw !== 'string') return undefined;
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(raw.split(','));
  return workspaceNames.length > 0 ? workspaceNames : undefined;
}

function resolveSourceDevWorkspaceNames({
  repoRoot,
  workspaceNames,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  const targetedWorkspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(workspaceNames);
  if (targetedWorkspaceNames.length > 0) {
    const resolveWorkspaceDependencyBuildOrder =
      typeof workspaceDependencyBuildOrder.resolveWorkspaceDependencyBuildOrder === 'function'
        ? workspaceDependencyBuildOrder.resolveWorkspaceDependencyBuildOrder
        : ({ seedPackageNames }) => normalizeSourceDevSharedDepsWorkspaceNames(seedPackageNames);
    return resolveWorkspaceDependencyBuildOrder({
      repoRoot,
      seedPackageNames: targetedWorkspaceNames,
      existsSync: exists,
      readFileSync: readFile,
    });
  }

  return resolveCliBundledWorkspacePackageNames({ repoRoot, exists });
}

function readStatsSignature(path, { exists = existsSync, stat = statSync } = {}) {
  if (!exists(path)) return { exists: false };
  try {
    const stats = stat(path);
    return {
      exists: true,
      type: stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other',
      size: Number(stats.size ?? 0),
      mtimeMs: Number(stats.mtimeMs ?? 0),
    };
  } catch {
    return { exists: false };
  }
}

function readTreeSignature(rootPath, { exists = existsSync, readDir = readdirSync, stat = statSync } = {}) {
  if (!exists(rootPath)) return { exists: false, entries: [] };

  const entries = [];
  const visit = (dir, prefix) => {
    let children;
    try {
      children = readDir(dir, { withFileTypes: true });
    } catch {
      entries.push([prefix, 'unreadable']);
      return;
    }

    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = resolve(dir, child.name);
      const childRelativePath = prefix ? `${prefix}/${child.name}` : child.name;
      let stats;
      try {
        stats = stat(childPath);
      } catch {
        entries.push([childRelativePath, 'missing']);
        continue;
      }

      if (stats.isDirectory()) {
        entries.push([childRelativePath, 'dir', Number(stats.mtimeMs ?? 0)]);
        visit(childPath, childRelativePath);
        continue;
      }

      entries.push([
        childRelativePath,
        stats.isFile() ? 'file' : 'other',
        Number(stats.size ?? 0),
        Number(stats.mtimeMs ?? 0),
      ]);
    }
  };

  visit(rootPath, '');
  return { exists: true, entries };
}

function shouldIgnoreBuildFreshnessSourcePath(path) {
  return /\.(?:test|spec|integration|e2e|slow)\.[cm]?[jt]sx?$/.test(path);
}

function readNewestPathMtimeMs(path, { exists = existsSync, readDir = readdirSync, stat = statSync } = {}) {
  if (shouldIgnoreBuildFreshnessSourcePath(path)) return 0;
  if (!exists(path)) return 0;

  try {
    const stats = stat(path);
    if (!stats.isDirectory()) return Number(stats.mtimeMs ?? 0);

    let newestMtimeMs = 0;
    for (const entry of readDir(path, { withFileTypes: true })) {
      newestMtimeMs = Math.max(
        newestMtimeMs,
        readNewestPathMtimeMs(resolve(path, entry.name), { exists, readDir, stat }),
      );
    }
    return newestMtimeMs > 0 ? newestMtimeMs : Number(stats.mtimeMs ?? 0);
  } catch {
    return 0;
  }
}

function readNewestPathsMtimeMs(paths, fsOps = {}) {
  return paths.reduce(
    (newestMtimeMs, candidatePath) => Math.max(newestMtimeMs, readNewestPathMtimeMs(candidatePath, fsOps)),
    0,
  );
}

function readOldestExistingPathMtimeMs(paths, { exists = existsSync, stat = statSync } = {}) {
  let oldestMtimeMs = Number.POSITIVE_INFINITY;
  for (const candidatePath of paths) {
    if (!exists(candidatePath)) return 0;
    try {
      oldestMtimeMs = Math.min(oldestMtimeMs, Number(stat(candidatePath).mtimeMs ?? 0));
    } catch {
      return 0;
    }
  }
  return Number.isFinite(oldestMtimeMs) ? oldestMtimeMs : 0;
}

function collectPackageJsonDistTargets(value, result) {
  if (typeof value === 'string') {
    if (value.startsWith('./dist/')) {
      result.add(value.slice(2));
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPackageJsonDistTargets(item, result);
    return;
  }
  for (const nested of Object.values(value)) collectPackageJsonDistTargets(nested, result);
}

function resolveWorkspaceExpectedOutputPaths({ packageDir, readFile = readFileSync }) {
  const outputPaths = new Set();
  try {
    const raw = readJsonFile(resolve(packageDir, 'package.json'), readFile);
    collectPackageJsonDistTargets(raw?.main, outputPaths);
    collectPackageJsonDistTargets(raw?.module, outputPaths);
    collectPackageJsonDistTargets(raw?.types, outputPaths);
    collectPackageJsonDistTargets(raw?.exports, outputPaths);
  } catch {
    outputPaths.add('dist/index.js');
  }

  if (outputPaths.size === 0) outputPaths.add('dist/index.js');
  return [...outputPaths].map((relativePath) => resolve(packageDir, relativePath));
}

function isSourceDevWorkspaceBuildStale({
  packageDir,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  if (!exists(resolve(packageDir, 'src'))) {
    return false;
  }

  const expectedOutputPaths = resolveWorkspaceExpectedOutputPaths({ packageDir, readFile });
  if (!expectedOutputPaths.every((candidatePath) => exists(candidatePath))) {
    return true;
  }

  const oldestRuntimeOutputMtimeMs = readOldestExistingPathMtimeMs(expectedOutputPaths, { exists, stat });
  if (oldestRuntimeOutputMtimeMs <= 0) {
    return true;
  }

  const newestSourceMtimeMs = readNewestPathsMtimeMs([
    resolve(packageDir, 'src'),
    resolve(packageDir, 'package.json'),
    resolve(packageDir, 'tsconfig.json'),
  ], { exists, readDir, stat });
  if (newestSourceMtimeMs <= 0) {
    return false;
  }

  return newestSourceMtimeMs > oldestRuntimeOutputMtimeMs;
}

function collectStaleSourceDevWorkspaceBuilds({
  repoRoot,
  workspaceNames,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  const staleBuilds = [];
  for (const workspaceName of workspaceNames) {
    const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
    const tsconfigPath = resolveBundledWorkspaceTsconfigPath({ repoRoot, workspaceName });
    if (!exists(tsconfigPath)) continue;
    if (!isSourceDevWorkspaceBuildStale({ packageDir, exists, readFile, readDir, stat })) continue;
    staleBuilds.push({ workspaceName, tsconfigPath });
  }
  return staleBuilds;
}

export function computeSourceDevSharedDepsSignature(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const exists = opts.existsSync ?? existsSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  const workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    exists,
    readFile,
  });

  return {
    version: SOURCE_DEV_SHARED_DEPS_STAMP_VERSION,
    workspaceNames,
    packages: workspaceNames.map((workspaceName) => {
      const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
      return {
        workspaceName,
        source: readTreeSignature(resolve(packageDir, 'src'), { exists, readDir, stat }),
        tsconfig: readStatsSignature(resolve(packageDir, 'tsconfig.json'), { exists, stat }),
        packageJson: readStatsSignature(resolve(packageDir, 'package.json'), { exists, stat }),
        dist: readTreeSignature(resolve(packageDir, 'dist'), { exists, readDir, stat }),
      };
    }),
  };
}

function resolveSourceDevSharedDepsStampPath(repoRoot) {
  return resolve(repoRoot, '.project', 'tmp', 'cli-source-dev-shared-deps-sync.json');
}

function readSourceDevSharedDepsStamp(stampPath, readFile = readFileSync) {
  try {
    return JSON.parse(readFile(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

function createSourceDevSharedDepsStampKey(signature) {
  return JSON.stringify((signature?.workspaceNames ?? []).map((workspaceName) => String(workspaceName)));
}

function readSourceDevSharedDepsStampEntry({ stamp, signature }) {
  const stampKey = createSourceDevSharedDepsStampKey(signature);
  if (
    stamp?.version === SOURCE_DEV_SHARED_DEPS_STAMP_VERSION &&
    stamp.entries &&
    typeof stamp.entries === 'object' &&
    !Array.isArray(stamp.entries)
  ) {
    const entry = stamp.entries[stampKey];
    if (JSON.stringify(entry?.signature) === JSON.stringify(signature)) {
      return entry;
    }
    const supersetEntry = findSourceDevSharedDepsSupersetStampEntry({ stamp, signature });
    if (supersetEntry) {
      return supersetEntry;
    }
  }

  if (stamp?.version === 1 && JSON.stringify(stamp.signature) === JSON.stringify(signature)) {
    return {
      signature: stamp.signature,
      syncedAtMs: stamp.syncedAtMs,
    };
  }

  return null;
}

function findSourceDevSharedDepsSupersetStampEntry({ stamp, signature }) {
  const requestedWorkspaceNames = new Set((signature?.workspaceNames ?? []).map((workspaceName) => String(workspaceName)));
  if (requestedWorkspaceNames.size === 0) return null;

  for (const entry of Object.values(stamp.entries)) {
    const entrySignature = entry?.signature;
    if (entrySignature?.version !== signature?.version) continue;
    const entryWorkspaceNames = new Set((entrySignature.workspaceNames ?? []).map((workspaceName) => String(workspaceName)));
    if (![...requestedWorkspaceNames].every((workspaceName) => entryWorkspaceNames.has(workspaceName))) continue;
    if (sourceDevSharedDepsSignaturePackagesInclude({ supersetSignature: entrySignature, signature })) {
      return entry;
    }
  }

  return null;
}

function sourceDevSharedDepsSignaturePackagesInclude({ supersetSignature, signature }) {
  const packagesByWorkspaceName = new Map();
  for (const pkg of supersetSignature?.packages ?? []) {
    const workspaceName = String(pkg?.workspaceName ?? '');
    if (workspaceName) {
      packagesByWorkspaceName.set(workspaceName, pkg);
    }
  }

  for (const pkg of signature?.packages ?? []) {
    const workspaceName = String(pkg?.workspaceName ?? '');
    if (!workspaceName) return false;
    if (JSON.stringify(packagesByWorkspaceName.get(workspaceName)) !== JSON.stringify(pkg)) {
      return false;
    }
  }

  return true;
}

function createSourceDevSharedDepsStampPayload({ previousStamp, signature, syncedAtMs }) {
  const entries = {};
  if (
    previousStamp?.version === SOURCE_DEV_SHARED_DEPS_STAMP_VERSION &&
    previousStamp.entries &&
    typeof previousStamp.entries === 'object' &&
    !Array.isArray(previousStamp.entries)
  ) {
    Object.assign(entries, previousStamp.entries);
  } else if (previousStamp?.version === 1 && previousStamp.signature) {
    entries[createSourceDevSharedDepsStampKey(previousStamp.signature)] = {
      signature: previousStamp.signature,
      syncedAtMs: previousStamp.syncedAtMs,
    };
  }

  entries[createSourceDevSharedDepsStampKey(signature)] = {
    signature,
    syncedAtMs,
  };

  return {
    version: SOURCE_DEV_SHARED_DEPS_STAMP_VERSION,
    entries,
  };
}

function collectTreeEntryShape(treeSignature) {
  if (treeSignature?.exists !== true) return [];
  return (treeSignature.entries ?? []).map((entry) => {
    const [relativePath, entryType, entrySize] = entry;
    if (entryType === 'file' || entryType === 'other') {
      return [relativePath, entryType, entrySize];
    }
    return [relativePath, entryType];
  });
}

function treeEntryShapesEqual(leftTree, rightTree) {
  return JSON.stringify(collectTreeEntryShape(leftTree)) === JSON.stringify(collectTreeEntryShape(rightTree));
}

function pruneTreeEntriesMissingFromSource({ srcDir, destDir, exists, readDir, rm }) {
  if (!exists(srcDir) || !exists(destDir)) return;

  let destEntries;
  try {
    destEntries = readDir(destDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const destEntry of destEntries) {
    const srcPath = resolve(srcDir, destEntry.name);
    const destPath = resolve(destDir, destEntry.name);
    if (!exists(srcPath)) {
      rm(destPath, { recursive: true, force: true });
      continue;
    }
    if (destEntry.isDirectory()) {
      pruneTreeEntriesMissingFromSource({ srcDir: srcPath, destDir: destPath, exists, readDir, rm });
    }
  }
}

function pruneSourceDevBundledDistExtras({
  repoRoot,
  signature,
  exists = existsSync,
  readDir = readdirSync,
  rm = rmSync,
}) {
  for (const pkg of signature.packages ?? []) {
    if (pkg.dist?.exists !== true) continue;
    const workspaceName = String(pkg.workspaceName ?? '').trim();
    if (!workspaceName) continue;
    const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
    const srcDist = resolve(packageDir, 'dist');
    const destDist = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', workspaceName, 'dist');
    pruneTreeEntriesMissingFromSource({ srcDir: srcDist, destDir: destDist, exists, readDir, rm });
  }
}

function sourceDevSharedDepsOutputsExist({
  repoRoot,
  signature,
  exists = existsSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  for (const pkg of signature.packages ?? []) {
    const workspaceName = String(pkg.workspaceName ?? '').trim();
    if (!workspaceName) return false;
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', workspaceName);
    if (!exists(resolve(destPackageDir, 'package.json'))) return false;
    if (pkg.dist?.exists === true) {
      const destDist = resolve(destPackageDir, 'dist');
      if (!exists(destDist)) return false;
      const destDistSignature = readTreeSignature(destDist, { exists, readDir, stat });
      if (!treeEntryShapesEqual(pkg.dist, destDistSignature)) return false;
    }
  }

  return exists(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'package.json'));
}

function isSourceDevSharedDepsCurrent({
  repoRoot,
  stampPath,
  signature,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  const stamp = readSourceDevSharedDepsStamp(stampPath, readFile);
  if (!readSourceDevSharedDepsStampEntry({ stamp, signature })) return false;
  return sourceDevSharedDepsOutputsExist({ repoRoot, signature, exists, readDir, stat });
}

export async function syncSharedDepsForSourceDev(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const exists = opts.existsSync ?? existsSync;
  const mkdir = opts.mkdirSync ?? mkdirSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  const rm = opts.rmSync ?? rmSync;
  const writeFile = opts.writeFileSync ?? writeFileSync;
  const workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    exists,
    readFile,
  });
  const reportProgress = createSourceDevSharedDepsProgressReporter(opts);
  const workspaceBuildTimeoutMs = resolveSourceDevWorkspaceBuildTimeoutMs(opts.workspaceBuildTimeoutMs);
  const stampPath = opts.stampPath ?? resolveSourceDevSharedDepsStampPath(repoRoot);
  const lockOptions = resolveSourceDevSharedDepsLockOptions(opts.lockOptions ?? {});
  const lockPath = lockOptions.lockPath ?? resolveCliSharedDepsBuildLockPath(repoRoot);
  const resolvedLockOptions = { ...lockOptions, lockPath };
  const computeSignature = () => computeSourceDevSharedDepsSignature({
    repoRoot,
    workspaceNames,
    existsSync: exists,
    readFileSync: readFile,
    readdirSync: readDir,
    statSync: stat,
  });
  const collectStaleBuilds = () => collectStaleSourceDevWorkspaceBuilds({
    repoRoot,
    workspaceNames,
    exists,
    readFile,
    readDir,
    stat,
  });

  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'signature',
    event: 'start',
    workspaceCount: workspaceNames.length,
  });
  let signature = computeSignature();
  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'signature',
    event: 'done',
    workspaceCount: workspaceNames.length,
  });
  if (
    !exists(lockPath) &&
    isSourceDevSharedDepsCurrent({ repoRoot, stampPath, signature, exists, readFile, readDir, stat })
  ) {
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'complete',
      event: 'done',
      reason: 'current',
    });
    return { synced: false, reason: 'current' };
  }

  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'stale-scan',
    event: 'start',
    workspaceCount: workspaceNames.length,
  });
  let staleBuilds = collectStaleBuilds();
  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'stale-scan',
    event: 'done',
    staleWorkspaceCount: staleBuilds.length,
  });
  const withLock = opts.withBuildSharedDepsLockImpl ?? withBuildSharedDepsLock;
  reportSourceDevSharedDepsProgress(reportProgress, {
    stage: 'workspace-lock',
    event: 'waiting',
    lockTimeoutMs: resolvedLockOptions.timeoutMs,
  });
  return await withLock(async () => {
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'workspace-lock',
      event: 'acquired',
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'signature',
      event: 'start-after-lock',
      workspaceCount: workspaceNames.length,
    });
    signature = computeSignature();
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'signature',
      event: 'done-after-lock',
      workspaceCount: workspaceNames.length,
    });
    if (isSourceDevSharedDepsCurrent({ repoRoot, stampPath, signature, exists, readFile, readDir, stat })) {
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'complete',
        event: 'done',
        reason: 'current-after-lock',
      });
      return { synced: false, reason: 'current-after-lock' };
    }

    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stale-scan',
      event: 'start-after-lock',
      workspaceCount: workspaceNames.length,
    });
    staleBuilds = collectStaleBuilds();
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stale-scan',
      event: 'done-after-lock',
      staleWorkspaceCount: staleBuilds.length,
    });
    const compileWorkspace = opts.runTscImpl ?? runTsc;
    const syncWorkspaceBuildDependencies =
      opts.syncWorkspaceBundledDependenciesForBuildImpl ?? syncWorkspaceBundledDependenciesForBuild;
    for (const staleBuild of staleBuilds) {
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'workspace-build',
        event: 'start',
        workspaceName: staleBuild.workspaceName,
        tsconfigPath: staleBuild.tsconfigPath,
      });
      try {
        syncWorkspaceBuildDependencies({
          repoRoot,
          workspaceName: staleBuild.workspaceName,
          syncId: `source-dev-build.${process.pid}`,
        });
        compileWorkspace(staleBuild.tsconfigPath, workspaceBuildTimeoutMs ? { timeoutMs: workspaceBuildTimeoutMs } : undefined);
      } catch (error) {
        reportSourceDevSharedDepsProgress(reportProgress, {
          stage: 'workspace-build',
          event: 'failed',
          workspaceName: staleBuild.workspaceName,
          tsconfigPath: staleBuild.tsconfigPath,
        });
        throw error;
      }
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'workspace-build',
        event: 'done',
        workspaceName: staleBuild.workspaceName,
        tsconfigPath: staleBuild.tsconfigPath,
      });
    }
    if (staleBuilds.length > 0) {
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'signature',
        event: 'start-after-build',
        workspaceCount: workspaceNames.length,
      });
      signature = computeSignature();
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'signature',
        event: 'done-after-build',
        workspaceCount: workspaceNames.length,
      });
    }

    const syncId = opts.syncId ?? `source-dev.${process.pid}`;
    const syncBundledDist = opts.syncBundledWorkspaceDistImpl ?? syncBundledWorkspaceDist;
    const syncBundledRuntimeDependencies =
      opts.syncBundledWorkspaceRuntimeDependenciesImpl ?? syncBundledWorkspaceRuntimeDependencies;
    const syncCliDependencies = opts.syncCliRuntimeDependenciesImpl ?? syncCliRuntimeDependencies;

    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-sync',
      event: 'start',
      syncId,
    });
    syncBundledDist({
      repoRoot,
      replaceExisting: false,
      syncId,
      workspaceNames,
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-sync',
      event: 'done',
      syncId,
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-prune',
      event: 'start',
    });
    pruneSourceDevBundledDistExtras({ repoRoot, signature, exists, readDir, rm });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-prune',
      event: 'done',
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-runtime-deps-sync',
      event: 'start',
    });
    syncBundledRuntimeDependencies({ repoRoot, workspaceNames });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-runtime-deps-sync',
      event: 'done',
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'cli-runtime-deps-sync',
      event: 'start',
    });
    syncCliDependencies({ repoRoot });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'cli-runtime-deps-sync',
      event: 'done',
    });

    if (!sourceDevSharedDepsOutputsExist({ repoRoot, signature, exists, readDir, stat })) {
      reportSourceDevSharedDepsProgress(reportProgress, {
        stage: 'complete',
        event: 'done',
        stamped: false,
      });
      return { synced: true, stamped: false };
    }

    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stamp-write',
      event: 'start',
      stampPath,
    });
    mkdir(dirname(stampPath), { recursive: true });
    const syncedAtMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    writeFile(
      stampPath,
      `${JSON.stringify(createSourceDevSharedDepsStampPayload({
        previousStamp: readSourceDevSharedDepsStamp(stampPath, readFile),
        signature,
        syncedAtMs,
      }), null, 2)}\n`,
      'utf8',
    );
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stamp-write',
      event: 'done',
      stampPath,
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'complete',
      event: 'done',
      stamped: true,
    });
    return { synced: true, stamped: true };
  }, resolvedLockOptions);
}

export function main(options = {}) {
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
    const cliCommonWorkspacesModule = await loadCliCommonWorkspacesModule();
    syncBundledWorkspaceDist({ repoRoot });
    syncBundledWorkspaceRuntimeDependencies({ repoRoot, ...cliCommonWorkspacesModule });
    syncCliRuntimeDependencies({ repoRoot, ...cliCommonWorkspacesModule });
  }, options);
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
