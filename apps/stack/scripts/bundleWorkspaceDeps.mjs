import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent } from './utils/proc/pm.mjs';
import { execYarn } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

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

async function loadCliCommonWorkspacesModule(repoRoot) {
  const cliCommonPackageJsonPath = resolve(repoRoot, 'packages', 'cli-common', 'package.json');
  if (existsSync(cliCommonPackageJsonPath)) {
    // Fail fast with a JSON parse error instead of surfacing Node's less-specific
    // "Invalid package config" error when importing ESM from a malformed package.json.
    JSON.parse(String(readFileSync(cliCommonPackageJsonPath, 'utf8')));
  }

  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  if (!existsSync(modulePath)) {
    const rootPackageJsonPath = resolve(repoRoot, 'package.json');
    const hasWorkspaces = (() => {
      if (!existsSync(rootPackageJsonPath)) return false;
      const parsed = JSON.parse(String(readFileSync(rootPackageJsonPath, 'utf8')));
      return Boolean(parsed && typeof parsed === 'object' && (parsed.workspaces || parsed.workspaces?.packages));
    })();

    if (hasWorkspaces) {
      const stackDir = resolve(repoRoot, 'apps', 'stack');
      await ensureWorkspacePackagesBuiltForComponent(stackDir, { quiet: true, env: process.env });
      if (!existsSync(modulePath)) {
        execYarn(['-s', 'workspace', '@happier-dev/cli-common', 'build'], {
          cwd: repoRoot,
          stdio: 'inherit',
        });
      }
    }
  }

  if (!existsSync(modulePath)) {
    throw new Error('Missing dist/ for @happier-dev/cli-common');
  }

  return await import(pathToFileURL(modulePath).href);
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

  const stats = statSync(targetPath);
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
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = resolve(currentDir, entry.name);
      const entryStats = statSync(entryPath);
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
    for (const entry of readdirSync(current.absoluteDir, { withFileTypes: true })) {
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
      return {
        packageName: resolveBundlePackageName(bundle),
        packageJson: collectPathFingerprint(packageJsonPath),
        dist: collectPathFingerprint(resolve(bundle.srcDir, 'dist')),
        distFiles: collectRelativeFilePaths(resolve(bundle.srcDir, 'dist'), 'dist'),
        expectedFiles: collectExpectedPackageFiles(packageJson, bundle.srcDir),
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
  const lockPath = opts.lockPath ?? resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

  return withWorkspaceBundleLock(async () => {
    const {
      bundleWorkspacePackages,
      resolveWorkspaceBundlesFromPackageJson,
      vendorBundledPackageRuntimeDependencies,
    } = await loadCliCommonWorkspacesModule(repoRoot);

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: stackDir,
    });

    const sourceSignature = buildWorkspaceBundleSourceSignature({ bundles });
    if (bundledWorkspaceManifestIsFresh({ stackDir, bundles, sourceSignature })) {
      return;
    }

    bundleWorkspacePackages({ bundles });

    for (const b of bundles) {
      vendorBundledPackageRuntimeDependencies({
        srcPackageJsonPath: resolve(b.srcDir, 'package.json'),
        destPackageDir: b.destDir,
      });
    }

    writeWorkspaceBundleManifest({ stackDir, sourceSignature });
  }, { lockPath, timeoutMs: 240_000, pollIntervalMs: 250, staleAfterMs: 240_000 });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    await bundleWorkspaceDeps();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
