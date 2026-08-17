import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import {
  ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault,
} from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { loadCliCommonWorkspacesModule } from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_BUNDLE_MANIFEST_FILENAME = '.workspace-bundle-manifest.json';

function resolveBundlePackageName(bundle) {
  return String(bundle?.packageName ?? bundle?.name ?? '').trim();
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
  return resolve(startDir, '..', '..', '..');
}

function collectPackageJsonRelativeFileTargets(value, result = new Set()) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('./') && !trimmed.includes('*')) {
      result.add(trimmed.slice(2));
    } else if (trimmed.startsWith('dist/') && !trimmed.includes('*')) {
      result.add(trimmed);
    } else if (!trimmed.includes('*') && !trimmed.startsWith('#') && !trimmed.startsWith('node:') && !trimmed.startsWith('file:')) {
      result.add(trimmed);
    }
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPackageJsonRelativeFileTargets(item, result);
    }
    return result;
  }
  for (const item of Object.values(value)) {
    collectPackageJsonRelativeFileTargets(item, result);
  }
  return result;
}

function collectExpectedPackageFiles(pkgJson, packageDir, options = {}) {
  const result = new Set();
  collectPackageJsonRelativeFileTargets(pkgJson?.main, result);
  collectPackageJsonRelativeFileTargets(pkgJson?.module, result);
  collectPackageJsonRelativeFileTargets(pkgJson?.types, result);
  collectPackageJsonRelativeFileTargets(pkgJson?.exports, result);
  const requireExisting = options.requireExisting !== false;
  const relativePaths = [...result].sort();
  if (!requireExisting) {
    return relativePaths;
  }
  return relativePaths.filter((relativePath) => existsSync(resolve(packageDir, relativePath)));
}

function collectExternalRuntimeDependencyNames(pkgJson) {
  const names = new Set();
  for (const deps of [pkgJson?.dependencies, pkgJson?.optionalDependencies]) {
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@happier-dev/')) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function collectPathFingerprint(targetPath) {
  if (!existsSync(targetPath)) return null;

  let stats;
  try {
    stats = statSync(targetPath);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stats.isDirectory()) {
    return {
      kind: 'file',
      size: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
    };
  }

  let fileCount = 0;
  let totalSize = 0;
  let maxMtimeMs = Math.trunc(stats.mtimeMs);
  const dirs = [targetPath];
  while (dirs.length > 0) {
    const currentDir = dirs.pop();
    if (!currentDir) continue;
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = resolve(currentDir, entry.name);
      let entryStats;
      try {
        entryStats = statSync(entryPath);
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
        throw error;
      }
      maxMtimeMs = Math.max(maxMtimeMs, Math.trunc(entryStats.mtimeMs));
      if (entry.isDirectory()) {
        dirs.push(entryPath);
        continue;
      }
      fileCount += 1;
      totalSize += entryStats.size;
    }
  }

  return {
    kind: 'dir',
    fileCount,
    totalSize,
    maxMtimeMs,
  };
}

function collectRelativeFilePaths(targetDir, relativePrefix = '') {
  const root = String(targetDir ?? '').trim();
  if (!root || !existsSync(root)) return [];

  const relativePaths = [];
  const dirs = [{ absoluteDir: root, relativeDir: String(relativePrefix ?? '').trim() }];
  while (dirs.length > 0) {
    const current = dirs.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current.absoluteDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = resolve(current.absoluteDir, entry.name);
      const relativePath = current.relativeDir ? `${current.relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.push({ absoluteDir: absolutePath, relativeDir: relativePath });
        continue;
      }
      relativePaths.push(relativePath);
    }
  }

  return relativePaths.sort();
}

function collectOwnPackageRelativeFilePaths(packageDir) {
  return collectRelativeFilePaths(packageDir).filter((relativePath) => !relativePath.startsWith('node_modules/'));
}

function collectRuntimeDependencyNames(pkgJson) {
  return collectExternalRuntimeDependencyNames(pkgJson);
}

function buildRuntimeDependencySignature({ repoRoot, packageName, visited = new Set() }) {
  const normalizedName = String(packageName ?? '').trim();
  if (!normalizedName || visited.has(normalizedName)) {
    return null;
  }
  visited.add(normalizedName);

  const packageDir = resolve(repoRoot, 'node_modules', ...normalizedName.split('/'));
  const packageJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  const packageJson = JSON.parse(String(readFileSync(packageJsonPath, 'utf8')));
  return {
    packageName: normalizedName,
    ownFiles: collectOwnPackageRelativeFilePaths(packageDir),
    dependencies: collectRuntimeDependencyNames(packageJson)
      .map((dependencyName) => buildRuntimeDependencySignature({ repoRoot, packageName: dependencyName, visited }))
      .filter(Boolean),
  };
}

function collectRuntimeDependencySignatures({ repoRoot, pkgJson }) {
  return collectRuntimeDependencyNames(pkgJson)
    .map((dependencyName) => buildRuntimeDependencySignature({ repoRoot, packageName: dependencyName }))
    .filter(Boolean);
}

function buildWorkspaceBundleSourceSignature({ bundles }) {
  return {
    version: 3,
    bundles: bundles.map((bundle) => {
      const packageJsonPath = resolve(bundle.srcDir, 'package.json');
      const packageJson = JSON.parse(String(readFileSync(packageJsonPath, 'utf8')));
      const expectedFiles = collectExpectedPackageFiles(packageJson, bundle.srcDir);
      return {
        packageName: resolveBundlePackageName(bundle),
        packageJson: collectPathFingerprint(packageJsonPath),
        dist: collectPathFingerprint(resolve(bundle.srcDir, 'dist')),
        distFiles: collectRelativeFilePaths(resolve(bundle.srcDir, 'dist'), 'dist'),
        expectedFiles,
        expectedRootFiles: expectedFiles
          .filter((relativePath) => !relativePath.startsWith('dist/'))
          .map((relativePath) => ({
            relativePath,
            fingerprint: collectPathFingerprint(resolve(bundle.srcDir, relativePath)),
          })),
        externalRuntimeDependencies: collectRuntimeDependencySignatures({
          repoRoot: findRepoRoot(bundle.srcDir),
          pkgJson: packageJson,
        }),
      };
    }),
  };
}

function resolveWorkspaceBundleManifestPath(stackDir) {
  return resolve(stackDir, 'node_modules', '@happier-dev', WORKSPACE_BUNDLE_MANIFEST_FILENAME);
}

function isBundledWorkspaceComplete({ bundle, sourceBundleSignature }) {
  if (!existsSync(resolve(bundle.destDir, 'package.json'))) {
    return false;
  }

  for (const relativePath of sourceBundleSignature.distFiles ?? []) {
    if (!existsSync(resolve(bundle.destDir, relativePath))) {
      return false;
    }
  }

  for (const relativePath of sourceBundleSignature.expectedFiles) {
    if (!existsSync(resolve(bundle.destDir, relativePath))) {
      return false;
    }
  }

  for (const { relativePath } of sourceBundleSignature.expectedRootFiles ?? []) {
    const sourcePath = resolve(bundle.srcDir, relativePath);
    const bundledPath = resolve(bundle.destDir, relativePath);
    if (!existsSync(sourcePath) || !readFileSync(sourcePath).equals(readFileSync(bundledPath))) {
      return false;
    }
  }

  for (const dependencySignature of sourceBundleSignature.externalRuntimeDependencies) {
    if (!isVendoredDependencyTreeComplete({
      packageDir: resolve(bundle.destDir, 'node_modules', ...dependencySignature.packageName.split('/')),
      dependencySignature,
    })) {
      return false;
    }
  }

  return true;
}

function isVendoredDependencyTreeComplete({ packageDir, dependencySignature, visited = new Set() }) {
  const normalizedPackageDir = String(packageDir ?? '').trim();
  const packageName = String(dependencySignature?.packageName ?? '').trim();
  const visitKey = `${packageName}:${normalizedPackageDir}`;
  if (!normalizedPackageDir || !packageName || visited.has(visitKey)) {
    return true;
  }
  visited.add(visitKey);

  const packageJsonPath = resolve(normalizedPackageDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(String(readFileSync(packageJsonPath, 'utf8')));
  } catch {
    return false;
  }

  for (const relativePath of dependencySignature.ownFiles ?? []) {
    if (!existsSync(resolve(normalizedPackageDir, relativePath))) {
      return false;
    }
  }

  for (const nestedDependency of dependencySignature.dependencies ?? []) {
    if (!isVendoredDependencyTreeComplete({
      packageDir: resolve(normalizedPackageDir, 'node_modules', ...nestedDependency.packageName.split('/')),
      dependencySignature: nestedDependency,
      visited,
    })) {
      return false;
    }
  }

  return true;
}

function bundledWorkspaceManifestIsFresh({ stackDir, bundles, sourceSignature }) {
  const manifestPath = resolveWorkspaceBundleManifestPath(stackDir);
  if (!existsSync(manifestPath)) return false;

  let manifest;
  try {
    manifest = JSON.parse(String(readFileSync(manifestPath, 'utf8')));
  } catch {
    return false;
  }

  if (JSON.stringify(manifest) !== JSON.stringify(sourceSignature)) {
    return false;
  }

  const sourceBundlesByName = new Map(sourceSignature.bundles.map((bundle) => [bundle.packageName, bundle]));
  for (const bundle of bundles) {
    const sourceBundleSignature = sourceBundlesByName.get(resolveBundlePackageName(bundle));
    if (!sourceBundleSignature) return false;
    if (!isBundledWorkspaceComplete({ bundle, sourceBundleSignature })) {
      return false;
    }
  }

  return true;
}

function writeWorkspaceBundleManifest({ stackDir, sourceSignature }) {
  const manifestPath = resolveWorkspaceBundleManifestPath(stackDir);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(sourceSignature, null, 2)}\n`, 'utf8');
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const stackDir = opts.stackDir ?? resolve(repoRoot, 'apps', 'stack');
  const lockPath = opts.lockPath ?? resolveWorkspaceBundleLockPath(repoRoot);
  const baseEnv = opts.env ?? process.env;
  const publicationMode = opts.publicationMode ?? 'live';
  const forceArtifactWorkspaceBuilds = publicationMode === 'artifact';
  const ensureWorkspacePackagesBuiltByName = opts.ensureWorkspacePackagesBuiltByName
    ?? ensureWorkspacePackagesBuiltByNameDefault;

  return withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const heldLockEnv = createWorkspaceChildBuildEnv({
      env: baseEnv,
      heldLockValue,
    });
    const {
      bundleWorkspacePackagesWithRuntimeDependencies,
      resolveWorkspaceBundlesFromPackageJson,
    } = await loadCliCommonWorkspacesModule(
      repoRoot,
      heldLockEnv,
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
      hostPackageDir: stackDir,
    });
    await ensureWorkspacePackagesBuiltByName(
      repoRoot,
      [...new Set(bundles.map(resolveBundlePackageName).filter(Boolean))],
      {
        quiet: true,
        env: heldLockEnv,
        includeDevDependencies: false,
        publicationMode,
        ...(forceArtifactWorkspaceBuilds
          ? { force: true }
          : {}),
      },
    );

    const sourceSignature = buildWorkspaceBundleSourceSignature({ bundles });
    if (
      publicationMode !== 'artifact'
      && bundledWorkspaceManifestIsFresh({ stackDir, bundles, sourceSignature })
    ) {
      return;
    }

    bundleWorkspacePackagesWithRuntimeDependencies({ bundles, publicationMode });

    writeWorkspaceBundleManifest({ stackDir, sourceSignature });
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
