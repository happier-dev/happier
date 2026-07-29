import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ensureWorkspacePackagesBuiltByName,
} from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import {
  loadCliCommonWorkspacesModule,
} from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import {
  syncBundledWorkspacePackages,
  vendorBundledPackageRuntimeDependenciesFallback,
} from '../../../scripts/workspaces/syncBundledWorkspacePackages.mjs';
import {
  assertResolvedRuntimeDependencyMatchesDeclaration,
  copyDirDereferenceContainedSync,
  resolveInstalledRuntimePackage,
} from '../../../packages/cli-common/workspaceRuntimeDependencies.mjs';
import * as workspaceDependencyBuildOrder from '../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import {
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BUNDLED_HOST_APPS = ['cli'];
const PLUGINS_WORKSPACE_PREFIX = 'plugins-';
const SOURCE_DEV_SHARED_DEPS_STAMP_VERSION = 4;
const SOURCE_DEV_SHARED_DEPS_PROGRESS_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_PROGRESS';
const SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_MS';
const SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_MS';
const SOURCE_DEV_SHARED_DEPS_WORKSPACES_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACES';
const SOURCE_DEV_SHARED_DEPS_PROGRESS_VALUE = 'json-v1';
const SOURCE_DEV_SHARED_DEPS_PROGRESS_PREFIX = '[happier-source-dev-shared-deps-progress] ';
const GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH = 'dist/happier-plugin-ui/ui-artifacts.json';

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

export async function resolveCliCommonWorkspacesHelpersAfterBuild(options = {}) {
  const resolvedRepoRoot = resolveRepoRootOption(options.repoRoot);
  const env = options.env ?? process.env;
  const loadedModule = await loadCliCommonWorkspacesModule(
    resolvedRepoRoot,
    env,
    options.ensureWorkspacePackagesBuiltByNameImpl ?? ensureWorkspacePackagesBuiltByName,
    {
      includeDevDependencies: false,
      quiet: options.quiet === true,
    },
  );
  return loadedModule?.helpers ?? loadedModule;
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

function bundleInstalledPackageWithRuntimeDependenciesFallback({
  packageName,
  declaredSpec,
  resolveFromPackageJsonPath,
  destNodeModulesDir,
  dereferenceRootDir,
}) {
  const resolved = resolveInstalledRuntimePackage({
    packageName,
    resolveFromPackageJsonPath,
    dereferenceRootDir,
  });
  assertResolvedRuntimeDependencyMatchesDeclaration({
    dependency: {
      name: packageName,
      optional: false,
      declaredSpec: declaredSpec ?? '',
    },
    resolvedPackageJsonPath: resolved.packageJsonPath,
    resolvedPackageJson: resolved.packageJson,
  });
  const sourcePackageDir = realpathSync(resolved.packageDir);
  const sourcePackageJsonPath = realpathSync(resolved.packageJsonPath);
  const destPackageDir = resolve(destNodeModulesDir, ...packageName.split('/'));

  mkdirSync(destNodeModulesDir, { recursive: true });
  rmSync(destPackageDir, { recursive: true, force: true });
  copyDirDereferenceContainedSync({
    sourceDir: sourcePackageDir,
    destDir: destPackageDir,
    dereferenceRootDir: dereferenceRootDir ?? sourcePackageDir,
  });
  vendorBundledPackageRuntimeDependenciesFallback({
    srcPackageJsonPath: sourcePackageJsonPath,
    resolveFromPackageJsonPath: sourcePackageJsonPath,
    destPackageDir,
    dereferenceRootDir,
  });
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
    cliCommonWorkspacesModule: opts.cliCommonWorkspacesModule,
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
  const cliPackageJson = readJsonFile(cliPackageJsonPath);
  const declaredSpec = cliPackageJson?.dependencies?.tweetnacl
    ?? cliPackageJson?.optionalDependencies?.tweetnacl;
  if (typeof declaredSpec !== 'string' || !declaredSpec.trim()) {
    throw new Error(`Missing CLI runtime dependency declaration for tweetnacl: ${cliPackageJsonPath}`);
  }
  const resolvedTweetnacl = resolveInstalledRuntimePackage({
    packageName: 'tweetnacl',
    resolveFromPackageJsonPath: cliPackageJsonPath,
    dereferenceRootDir: repoRoot,
  });
  assertResolvedRuntimeDependencyMatchesDeclaration({
    dependency: {
      name: 'tweetnacl',
      optional: false,
      declaredSpec: declaredSpec.trim(),
    },
    resolvedPackageJsonPath: resolvedTweetnacl.packageJsonPath,
    resolvedPackageJson: resolvedTweetnacl.packageJson,
  });
  const bundledTweetnaclDir = resolve(cliNodeModulesDir, 'tweetnacl');
  if (
    existsSync(bundledTweetnaclDir)
    && realpathSync(resolvedTweetnacl.packageDir) === realpathSync(bundledTweetnaclDir)
  ) {
    return;
  }

  bundleInstalledPackageWithRuntimeDependencies({
    packageName: 'tweetnacl',
    declaredSpec: declaredSpec.trim(),
    resolveFromPackageJsonPath: cliPackageJsonPath,
    destNodeModulesDir: cliNodeModulesDir,
    dereferenceRootDir: repoRoot,
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
      dereferenceRootDir: repoRoot,
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

export function readSourceDevSharedDepsWorkspaceNamesFromArgv(argv = process.argv.slice(2)) {
  const workspaceNames = normalizeSourceDevSharedDepsWorkspaceNames(
    argv.filter((value) => !String(value).trim().startsWith('--')),
  );
  return workspaceNames.length > 0 ? workspaceNames : undefined;
}

function resolveSourceDevWorkspaceNames({
  repoRoot,
  workspaceNames,
  includeDevDependencies = true,
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
      includeDevDependencies,
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

function readRuntimeDistTreeSignature(rootPath, fsOps = {}) {
  const signature = readTreeSignature(rootPath, fsOps);
  return {
    ...signature,
    entries: signature.entries.filter(([relativePath]) =>
      !String(relativePath).replaceAll('\\', '/').endsWith('.tsbuildinfo')),
  };
}

function shouldIgnoreBuildFreshnessSourcePath(path) {
  return /\.(?:test|spec|integration|e2e|slow)\.[cm]?[jt]sx?$/.test(path);
}

function readRuntimeSourceTreeSignature(rootPath, fsOps = {}) {
  const signature = readTreeSignature(rootPath, fsOps);
  return {
    ...signature,
    entries: signature.entries
      .filter(([relativePath, entryType]) =>
        entryType !== 'dir'
        && !shouldIgnoreBuildFreshnessSourcePath(String(relativePath).replaceAll('\\', '/'))),
  };
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

function resolveWorkspaceExpectedOutputPaths({
  packageDir,
  includeUiArtifacts = true,
  readFile = readFileSync,
}) {
  const outputPaths = new Set();
  try {
    const raw = readJsonFile(resolve(packageDir, 'package.json'), readFile);
    collectPackageJsonDistTargets(raw?.main, outputPaths);
    collectPackageJsonDistTargets(raw?.module, outputPaths);
    collectPackageJsonDistTargets(raw?.types, outputPaths);
    collectPackageJsonDistTargets(raw?.exports, outputPaths);
    if (
      includeUiArtifacts
      && typeof raw?.scripts?.['build:ui'] === 'string'
      && raw.scripts['build:ui'].trim()
    ) {
      outputPaths.add(GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH);
    }
  } catch {
    outputPaths.add('dist/index.js');
  }

  if (outputPaths.size === 0) outputPaths.add('dist/index.js');
  return [...outputPaths].map((relativePath) => resolve(packageDir, relativePath));
}

function isSourceDevWorkspaceBuildStale({
  packageDir,
  includeUiArtifacts = true,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  if (!exists(resolve(packageDir, 'src'))) {
    return false;
  }

  const expectedOutputPaths = resolveWorkspaceExpectedOutputPaths({
    packageDir,
    includeUiArtifacts,
    readFile,
  });
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
  includeUiArtifacts = true,
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
    if (!isSourceDevWorkspaceBuildStale({
      packageDir,
      includeUiArtifacts,
      exists,
      readFile,
      readDir,
      stat,
    })) continue;
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
    includeDevDependencies: opts.includeDevDependencies !== false,
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
        source: readRuntimeSourceTreeSignature(resolve(packageDir, 'src'), { exists, readDir, stat }),
        tsconfig: readStatsSignature(resolve(packageDir, 'tsconfig.json'), { exists, stat }),
        packageJson: readStatsSignature(resolve(packageDir, 'package.json'), { exists, stat }),
        dist: readRuntimeDistTreeSignature(resolve(packageDir, 'dist'), { exists, readDir, stat }),
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

function readCompatiblePreviousSourceDevSharedDepsSignature({ stamp, signature }) {
  if (
    stamp?.version !== SOURCE_DEV_SHARED_DEPS_STAMP_VERSION ||
    !stamp.entries ||
    typeof stamp.entries !== 'object' ||
    Array.isArray(stamp.entries)
  ) {
    return null;
  }

  const previousSignature = stamp.entries[createSourceDevSharedDepsStampKey(signature)]?.signature;
  if (
    previousSignature?.version !== signature?.version ||
    JSON.stringify(previousSignature.workspaceNames) !== JSON.stringify(signature?.workspaceNames) ||
    !Array.isArray(previousSignature.packages) ||
    previousSignature.packages.length !== signature?.packages?.length
  ) {
    return null;
  }

  const previousWorkspaceNames = previousSignature.packages.map((pkg) => String(pkg?.workspaceName ?? ''));
  if (new Set(previousWorkspaceNames).size !== previousWorkspaceNames.length) return null;
  if (JSON.stringify(previousWorkspaceNames) !== JSON.stringify(signature.workspaceNames)) return null;
  return previousSignature;
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
  workspaceNames,
  exists = existsSync,
  readDir = readdirSync,
  rm = rmSync,
}) {
  const selectedWorkspaceNames = workspaceNames ? new Set(workspaceNames) : null;
  for (const pkg of signature.packages ?? []) {
    if (pkg.dist?.exists !== true) continue;
    const workspaceName = String(pkg.workspaceName ?? '').trim();
    if (!workspaceName) continue;
    if (selectedWorkspaceNames && !selectedWorkspaceNames.has(workspaceName)) continue;
    const packageDir = resolveBundledWorkspacePackageDir({ repoRoot, workspaceName });
    const srcDist = resolve(packageDir, 'dist');
    const destDist = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', workspaceName, 'dist');
    pruneTreeEntriesMissingFromSource({ srcDir: srcDist, destDir: destDist, exists, readDir, rm });
  }
}

function sourceDevSharedDepsPackageOutputExists({
  repoRoot,
  pkg,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  const workspaceName = String(pkg?.workspaceName ?? '').trim();
  if (!workspaceName) return false;
  const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', workspaceName);
  if (!exists(resolve(destPackageDir, 'package.json'))) return false;
  const declaredOutputPaths = resolveWorkspaceExpectedOutputPaths({
    packageDir: destPackageDir,
    readFile,
  });
  if (!declaredOutputPaths.every((candidatePath) => exists(candidatePath))) return false;
  if (pkg.dist?.exists === true) {
    const destDist = resolve(destPackageDir, 'dist');
    if (!exists(destDist)) return false;
    const destDistSignature = readTreeSignature(destDist, { exists, readDir, stat });
    if (!treeEntryShapesEqual(pkg.dist, destDistSignature)) return false;
  }
  return true;
}

function sourceDevSharedDepsOutputsExist({
  repoRoot,
  signature,
  includeRuntimeDependencies = true,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  for (const pkg of signature.packages ?? []) {
    if (!sourceDevSharedDepsPackageOutputExists({ repoRoot, pkg, exists, readFile, readDir, stat })) return false;
  }

  return includeRuntimeDependencies
    ? exists(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'package.json'))
    : true;
}

function resolveSourceDevSharedDepsWorkspaceNamesToSync({
  repoRoot,
  stamp,
  signature,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
}) {
  const previousSignature = readCompatiblePreviousSourceDevSharedDepsSignature({ stamp, signature });
  if (!previousSignature) return signature.workspaceNames;

  const previousPackagesByWorkspaceName = new Map(
    previousSignature.packages.map((pkg) => [String(pkg.workspaceName), pkg]),
  );
  return signature.packages
    .filter((pkg) => {
      const workspaceName = String(pkg.workspaceName);
      return (
        JSON.stringify(previousPackagesByWorkspaceName.get(workspaceName)) !== JSON.stringify(pkg) ||
        !sourceDevSharedDepsPackageOutputExists({ repoRoot, pkg, exists, readFile, readDir, stat })
      );
    })
    .map((pkg) => String(pkg.workspaceName));
}

function isSourceDevSharedDepsCurrent({
  repoRoot,
  stampPath,
  signature,
  exists = existsSync,
  readFile = readFileSync,
  readDir = readdirSync,
  stat = statSync,
  includeRuntimeDependencies = true,
}) {
  const stamp = readSourceDevSharedDepsStamp(stampPath, readFile);
  if (!readSourceDevSharedDepsStampEntry({ stamp, signature })) return false;
  return sourceDevSharedDepsOutputsExist({
    repoRoot,
    signature,
    exists,
    readFile,
    readDir,
    stat,
    includeRuntimeDependencies,
  });
}

function writeSourceDevSharedDepsStamp({
  stampPath,
  signature,
  syncedAtMs,
  mkdir = mkdirSync,
  readFile = readFileSync,
  writeFile = writeFileSync,
}) {
  mkdir(dirname(stampPath), { recursive: true });
  writeFile(
    stampPath,
    `${JSON.stringify(createSourceDevSharedDepsStampPayload({
      previousStamp: readSourceDevSharedDepsStamp(stampPath, readFile),
      signature,
      syncedAtMs,
    }), null, 2)}\n`,
    'utf8',
  );
}

export function publishSourceDevReadinessFromRuntimeClosure(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const exists = opts.existsSync ?? existsSync;
  const mkdir = opts.mkdirSync ?? mkdirSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  const writeFile = opts.writeFileSync ?? writeFileSync;
  const workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    includeDevDependencies: false,
    exists,
    readFile,
  });
  const signature = computeSourceDevSharedDepsSignature({
    repoRoot,
    workspaceNames,
    includeDevDependencies: false,
    existsSync: exists,
    readFileSync: readFile,
    readdirSync: readDir,
    statSync: stat,
  });
  const staleBuilds = collectStaleSourceDevWorkspaceBuilds({
    repoRoot,
    workspaceNames,
    includeUiArtifacts: true,
    exists,
    readFile,
    readDir,
    stat,
  });
  if (staleBuilds.length > 0) {
    return {
      stamped: false,
      reason: 'stale-workspace-builds',
      workspaceNames: staleBuilds.map((build) => build.workspaceName),
    };
  }
  if (
    !sourceDevSharedDepsOutputsExist({
      repoRoot,
      signature,
      exists,
      readFile,
      readDir,
      stat,
      includeRuntimeDependencies: true,
    })
  ) {
    return { stamped: false, reason: 'runtime-outputs-incomplete' };
  }

  const stampPath = opts.stampPath ?? resolveSourceDevSharedDepsStampPath(repoRoot);
  const syncedAtMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  writeSourceDevSharedDepsStamp({
    stampPath,
    signature,
    syncedAtMs,
    mkdir,
    readFile,
    writeFile,
  });
  return { stamped: true };
}

export function publishSourceDevReadinessAfterRuntimeBuild(opts = {}) {
  const publishReadiness =
    opts.publishSourceDevReadinessFromRuntimeClosureImpl
    ?? publishSourceDevReadinessFromRuntimeClosure;
  return publishReadiness({
    repoRoot: resolveRepoRootOption(opts.repoRoot),
    workspaceNames: opts.workspaceNames,
  });
}

export function inspectSourceDevSharedDepsForSourceDev(opts = {}) {
  const repoRoot = resolveRepoRootOption(opts.repoRoot);
  const exists = opts.existsSync ?? existsSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const readDir = opts.readdirSync ?? readdirSync;
  const stat = opts.statSync ?? statSync;
  const includeRuntimeDependencies = opts.includeRuntimeDependencies !== false;
  const workspaceNames = resolveSourceDevWorkspaceNames({
    repoRoot,
    workspaceNames: opts.workspaceNames,
    exists,
    readFile,
  });
  const signature = computeSourceDevSharedDepsSignature({
    repoRoot,
    workspaceNames,
    includeDevDependencies: false,
    existsSync: exists,
    readFileSync: readFile,
    readdirSync: readDir,
    statSync: stat,
  });
  const stampPath = opts.stampPath ?? resolveSourceDevSharedDepsStampPath(repoRoot);
  return isSourceDevSharedDepsCurrent({
    repoRoot,
    stampPath,
    signature,
    exists,
    readFile,
    readDir,
    stat,
    includeRuntimeDependencies,
  })
    ? { current: true, reason: 'current' }
    : { current: false, reason: 'not-current' };
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
  const includeRuntimeDependencies = opts.includeRuntimeDependencies !== false;
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
    // This is already the complete closure selected above, not a fresh set of
    // targeted source-dev seeds.
    includeDevDependencies: false,
    existsSync: exists,
    readFileSync: readFile,
    readdirSync: readDir,
    statSync: stat,
  });
  const collectStaleBuilds = () => collectStaleSourceDevWorkspaceBuilds({
    repoRoot,
    workspaceNames,
    includeUiArtifacts: includeRuntimeDependencies,
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
  if (isSourceDevSharedDepsCurrent({ repoRoot, stampPath, signature, exists, readFile, readDir, stat, includeRuntimeDependencies })) {
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'complete',
      event: 'done',
      reason: 'current',
    });
    return { synced: false, reason: 'current' };
  }

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
    if (isSourceDevSharedDepsCurrent({ repoRoot, stampPath, signature, exists, readFile, readDir, stat, includeRuntimeDependencies })) {
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
    const staleBuilds = collectStaleBuilds();
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'stale-scan',
      event: 'done-after-lock',
      staleWorkspaceCount: staleBuilds.length,
    });
    const ensureWorkspacePackagesBuilt =
      opts.ensureWorkspacePackagesBuiltByNameImpl ?? ensureWorkspacePackagesBuiltByName;
    const syncWorkspaceBuildDependencies =
      opts.syncWorkspaceBundledDependenciesForBuildImpl ?? syncWorkspaceBundledDependenciesForBuild;
    const staleBuildByWorkspaceName = new Map(
      staleBuilds.map((staleBuild) => [staleBuild.workspaceName, staleBuild]),
    );
    if (staleBuilds.length > 0) {
      let activeBuild = null;
      const describePackageBuild = ({ packageDir, packageName }) => {
        const workspaceName = packageName.replace(/^@happier-dev\//, '');
        return staleBuildByWorkspaceName.get(workspaceName) ?? {
          workspaceName,
          tsconfigPath: resolve(packageDir, 'tsconfig.json'),
        };
      };
      try {
        await ensureWorkspacePackagesBuilt(
          repoRoot,
          staleBuilds.map((staleBuild) => `@happier-dev/${staleBuild.workspaceName}`),
          {
            quiet: opts.quiet !== false,
            env: opts.env ?? process.env,
            force: true,
            includeDevDependencies:
              normalizeSourceDevSharedDepsWorkspaceNames(opts.workspaceNames).length > 0,
            timeoutMs: workspaceBuildTimeoutMs,
            beforePackageBuild: ({ packageName }) => {
              const dependencyWorkspaceName = packageName.replace(/^@happier-dev\//, '');
              reportSourceDevSharedDepsProgress(reportProgress, {
                stage: 'workspace-build-dependencies',
                event: 'start',
                workspaceName: dependencyWorkspaceName,
              });
              syncWorkspaceBuildDependencies({
                repoRoot,
                workspaceName: dependencyWorkspaceName,
                syncId: `source-dev-build.${process.pid}`,
              });
              reportSourceDevSharedDepsProgress(reportProgress, {
                stage: 'workspace-build-dependencies',
                event: 'done',
                workspaceName: dependencyWorkspaceName,
              });
            },
            onPackageBuildStart: (context) => {
              activeBuild = describePackageBuild(context);
              reportSourceDevSharedDepsProgress(reportProgress, {
                stage: 'workspace-build',
                event: 'start',
                workspaceName: activeBuild.workspaceName,
                tsconfigPath: activeBuild.tsconfigPath,
              });
            },
            onPackageBuildDone: (context) => {
              const completedBuild = describePackageBuild(context);
              reportSourceDevSharedDepsProgress(reportProgress, {
                stage: 'workspace-build',
                event: 'done',
                workspaceName: completedBuild.workspaceName,
                tsconfigPath: completedBuild.tsconfigPath,
              });
              activeBuild = null;
            },
          },
        );
      } catch (error) {
        const failedBuild = activeBuild ?? staleBuilds[0];
        reportSourceDevSharedDepsProgress(reportProgress, {
          stage: 'workspace-build',
          event: 'failed',
          workspaceName: failedBuild.workspaceName,
          tsconfigPath: failedBuild.tsconfigPath,
        });
        throw error;
      }
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
    const workspaceNamesToSync = resolveSourceDevSharedDepsWorkspaceNamesToSync({
      repoRoot,
      stamp: readSourceDevSharedDepsStamp(stampPath, readFile),
      signature,
      exists,
      readFile,
      readDir,
      stat,
    });

    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-sync',
      event: 'start',
      syncId,
      workspaceCount: workspaceNamesToSync.length,
    });
    if (workspaceNamesToSync.length > 0) {
      syncBundledDist({
        repoRoot,
        replaceExisting: false,
        syncId,
        workspaceNames: workspaceNamesToSync,
      });
    }
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-sync',
      event: 'done',
      syncId,
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-prune',
      event: 'start',
    });
    pruneSourceDevBundledDistExtras({
      repoRoot,
      signature,
      workspaceNames: workspaceNamesToSync,
      exists,
      readDir,
      rm,
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-dist-prune',
      event: 'done',
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-runtime-deps-sync',
      event: 'start',
    });
    if (includeRuntimeDependencies && workspaceNamesToSync.length > 0) {
      syncBundledRuntimeDependencies({ repoRoot, workspaceNames: workspaceNamesToSync });
    }
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'bundled-runtime-deps-sync',
      event: 'done',
    });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'cli-runtime-deps-sync',
      event: 'start',
    });
    if (includeRuntimeDependencies) syncCliDependencies({ repoRoot });
    reportSourceDevSharedDepsProgress(reportProgress, {
      stage: 'cli-runtime-deps-sync',
      event: 'done',
    });

    if (!sourceDevSharedDepsOutputsExist({
      repoRoot,
      signature,
      exists,
      readFile,
      readDir,
      stat,
      includeRuntimeDependencies,
    })) {
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
    const syncedAtMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    writeSourceDevSharedDepsStamp({
      stampPath,
      signature,
      syncedAtMs,
      mkdir,
      readFile,
      writeFile,
    });
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

export async function buildBundledWorkspaceDependenciesForCli(opts = {}) {
  const resolvedRepoRoot = resolveRepoRootOption(opts.repoRoot);
  const workspaceNames = Array.isArray(opts.workspaceNames)
    ? opts.workspaceNames
    : resolveCliBundledWorkspacePackageNames({ repoRoot: resolvedRepoRoot });
  const syncWorkspaceBuildDependencies =
    opts.syncWorkspaceBundledDependenciesForBuildImpl ?? syncWorkspaceBundledDependenciesForBuild;
  const ensureWorkspacePackagesBuilt =
    opts.ensureWorkspacePackagesBuiltByNameImpl ?? ensureWorkspacePackagesBuiltByName;
  await ensureWorkspacePackagesBuilt(
    resolvedRepoRoot,
    workspaceNames.map((workspaceName) => `@happier-dev/${workspaceName}`),
    {
      quiet: opts.quiet === true,
      env: opts.env ?? process.env,
      includeDevDependencies: false,
      // Final CLI artifact publication must bind bundled package bytes to this
      // build. Timestamps can identify missing/likely-stale dev outputs, but
      // cannot prove derivation when stale bytes are recreated later.
      force: true,
      beforePackageBuild: ({ packageName }) => {
        // Some workspaces resolve internal dependencies through their bundled
        // node_modules copy. Refresh that copy after dependency owners have
        // published and immediately before this package builds.
        syncWorkspaceBuildDependencies({
          repoRoot: resolvedRepoRoot,
          workspaceName: packageName.replace(/^@happier-dev\//, ''),
          syncId: opts.syncId ?? `build-shared.${process.pid}`,
        });
      },
    },
  );

  return workspaceNames;
}

export function main(options = {}) {
  if (options.mode === 'declarations' || options.mode === 'source-dev') {
    const syncSharedDeps = options.syncSharedDepsForSourceDevImpl ?? syncSharedDepsForSourceDev;
    return syncSharedDeps({
      ...options,
      includeRuntimeDependencies: options.mode === 'source-dev',
      workspaceNames: options.workspaceNames ?? readSourceDevSharedDepsWorkspaceNamesFromEnv(options.env ?? process.env),
    });
  }

  return withBuildSharedDepsLock(async ({ heldLockValue } = {}) => {
    const workspaceNames = await buildBundledWorkspaceDependenciesForCli({
      repoRoot,
      ...options,
    });
    // Import build helpers only after the forced artifact closure is current.
    // Otherwise a stale-but-newer cli-common dist could steer publication even
    // though the package is rebuilt later in this same pass.
    const cliCommonWorkspacesModule =
      await resolveCliCommonWorkspacesHelpersAfterBuild({
        ...options,
        env: createWorkspaceChildBuildEnv({
          env: options.env ?? process.env,
          heldLockValue,
        }),
      });

    const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
    if (!existsSync(protocolDist)) {
      throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
    }

    // If the CLI currently has bundled workspace deps under apps/cli/node_modules,
    // keep their dist outputs in sync so local builds/tests do not consume stale artifacts.
    syncBundledWorkspaceDist({ repoRoot, cliCommonWorkspacesModule });
    syncBundledWorkspaceRuntimeDependencies({ repoRoot, ...cliCommonWorkspacesModule });
    syncCliRuntimeDependencies({ repoRoot, ...cliCommonWorkspacesModule });
    publishSourceDevReadinessAfterRuntimeBuild({
      repoRoot,
      workspaceNames,
      publishSourceDevReadinessFromRuntimeClosureImpl:
        options.publishSourceDevReadinessFromRuntimeClosureImpl,
    });
    // The completed runtime closure remains publishable when newer source has
    // already superseded it. The Stack freshness owner activates that coherent
    // build and schedules the trailing generation; source children separately
    // require a current readiness stamp through their spawn preflight.
  }, options);
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();

if (invokedAsMain) {
  const mode = process.argv.includes('--declarations')
    ? 'declarations'
    : process.argv.includes('--source-dev')
      ? 'source-dev'
      : 'runtime';
  main({ mode }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
