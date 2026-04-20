import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { execYarn } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveWorkspaceDependencyBuildOrder } from '../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO_ROOT = findRepoRoot(__dirname);
const EXTENSIONS_PACKAGE_PREFIX = '@happier-dev/extensions-';

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
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  if (!existsSync(modulePath)) {
    for (const workspaceName of resolveWorkspaceDependencyBuildOrder({
      repoRoot,
      seedPackageNames: ['@happier-dev/cli-common'],
    })) {
      execYarn(['-s', 'workspace', `@happier-dev/${workspaceName}`, 'build'], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
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

function readJsonSync(path) {
  // Local helper to keep this script self-contained even when invoked against a sandbox repo.
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readBundledDependencyNames(rawPackageJson) {
  const bundledDependencies = Array.isArray(rawPackageJson?.bundledDependencies)
    ? rawPackageJson.bundledDependencies
    : Array.isArray(rawPackageJson?.bundleDependencies)
      ? rawPackageJson.bundleDependencies
      : [];

  return bundledDependencies
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
}

function resolveDeclaredBundledExtensionWorkspacePackageNames({ repoRoot }) {
  const extensionsRoot = resolve(repoRoot, 'packages', 'extensions');
  if (!existsSync(extensionsRoot)) return [];

  const packageNames = [];
  for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const extensionId = entry.name;
    // Reserve underscore-prefixed directories for scaffolding/non-shippable templates.
    if (extensionId.startsWith('_')) continue;
    const pkgJsonPath = resolve(extensionsRoot, extensionId, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    const expectedPackageName = `${EXTENSIONS_PACKAGE_PREFIX}${extensionId}`;
    const raw = readJsonSync(pkgJsonPath);
    if (raw?.name !== expectedPackageName) {
      throw new Error(
        [
          `[bundle-workspace-deps] Invalid bundled extension workspace package name`,
          `path: ${pkgJsonPath}`,
          `expected: ${expectedPackageName}`,
          `actual: ${String(raw?.name ?? '')}`,
        ].join('\n'),
      );
    }

    packageNames.push(expectedPackageName);
  }

  packageNames.sort((a, b) => a.localeCompare(b));
  return packageNames;
}

function resolveBundledWorkspaceSrcDir({ repoRoot, packageName }) {
  if (packageName.startsWith(EXTENSIONS_PACKAGE_PREFIX)) {
    const extensionId = packageName.slice(EXTENSIONS_PACKAGE_PREFIX.length);
    return resolve(repoRoot, 'packages', 'extensions', extensionId);
  }

  const workspaceName = packageName.split('/').at(-1);
  if (!workspaceName) {
    throw new Error(`Unable to resolve workspace name from bundled dependency: ${packageName}`);
  }

  return resolve(repoRoot, 'packages', workspaceName);
}

export async function bundleWorkspaceDeps(opts = {}) {
  // `repoRoot`/`happyCliDir` refer to the target repository we are bundling into.
  // In tests, this is a sandbox directory. The implementation helpers (cli-common workspaces)
  // must still be loaded from the *script* repo (this monorepo checkout), not from the sandbox.
  const targetRepoRoot = opts.repoRoot ?? SCRIPT_REPO_ROOT;
  const happyCliDir = opts.happyCliDir ?? resolve(targetRepoRoot, 'apps', 'cli');
  const lockPath = opts.lockPath ?? resolve(targetRepoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

  return withWorkspaceBundleLock(async () => {
    const {
      bundleWorkspacePackages,
      readBundledWorkspacePackageNames,
      vendorBundledPackageRuntimeDependencies,
    } = await loadCliCommonWorkspacesModule(SCRIPT_REPO_ROOT);

    const hostPackageJsonPath = resolve(happyCliDir, 'package.json');
    const hostPackageJsonRaw = readJsonSync(hostPackageJsonPath);
    const bundledDependencyNames = readBundledDependencyNames(hostPackageJsonRaw);

    // Guardrail: if extension workspaces exist under `packages/extensions/*`, they must be explicitly
    // declared as bundled dependencies in `apps/cli/package.json`. Otherwise, they will not ship in
    // the packed artifact even if we can bundle them locally.
    const discoveredBundledExtensionPackageNames = resolveDeclaredBundledExtensionWorkspacePackageNames({
      repoRoot: targetRepoRoot,
    });
    const missingExtensionPackages = discoveredBundledExtensionPackageNames.filter(
      (packageName) => !bundledDependencyNames.includes(packageName),
    );
    if (missingExtensionPackages.length > 0) {
      throw new Error(
        [
          `[bundle-workspace-deps] Missing bundled extension workspace dependencies`,
          `These packages exist under packages/extensions/* but are not declared in apps/cli/package.json#bundledDependencies:`,
          ...missingExtensionPackages.map((name) => `- ${name}`),
          ``,
          `Fix: node apps/cli/scripts/syncBundledExtensionWorkspaces.mjs`,
        ].join('\n'),
      );
    }

    const bundledWorkspacePackageNames = readBundledWorkspacePackageNames(hostPackageJsonRaw);
    const bundles = bundledWorkspacePackageNames.map((packageName) => ({
      packageName,
      srcDir: resolveBundledWorkspaceSrcDir({ repoRoot: targetRepoRoot, packageName }),
      destDir: resolve(happyCliDir, 'node_modules', ...packageName.split('/')),
    }));
    bundleWorkspacePackages({ bundles });

    for (const b of bundles) {
      vendorBundledPackageRuntimeDependencies({
        srcPackageJsonPath: resolve(b.srcDir, 'package.json'),
        destPackageDir: b.destDir,
      });
    }
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
