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
const PLUGINS_PACKAGE_PREFIX = '@happier-dev/plugins-';

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

function isReservationOnlyPluginPackage(rawPackageJson) {
  return rawPackageJson?.happier?.pluginScaffold?.shipping === 'reservation_only';
}

function resolveDeclaredBundledPluginWorkspacePackageNames({ repoRoot }) {
  const pluginsRoot = resolve(repoRoot, 'packages', 'plugins');
  if (!existsSync(pluginsRoot)) return [];

  const packageNames = [];
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginId = entry.name;
    // Reserve underscore-prefixed directories for scaffolding/non-shippable templates.
    if (pluginId.startsWith('_')) continue;
    const pkgJsonPath = resolve(pluginsRoot, pluginId, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const raw = readJsonSync(pkgJsonPath);
    if (isReservationOnlyPluginPackage(raw)) continue;

    const manifestPath = resolve(pluginsRoot, pluginId, 'src/manifest.ts');
    if (!existsSync(manifestPath)) {
      throw new Error(
        [
          `[bundle-workspace-deps] Missing required plugin manifest for shippable plugin package`,
          `path: ${manifestPath}`,
          `package: ${PLUGINS_PACKAGE_PREFIX}${pluginId}`,
        ].join('\n'),
      );
    }

    const expectedPackageName = `${PLUGINS_PACKAGE_PREFIX}${pluginId}`;
    if (raw?.name !== expectedPackageName) {
      throw new Error(
        [
          `[bundle-workspace-deps] Invalid bundled plugin workspace package name`,
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
      resolveWorkspaceBundlesFromPackageJson,
      vendorBundledPackageRuntimeDependencies,
    } = await loadCliCommonWorkspacesModule(SCRIPT_REPO_ROOT);

    const hostPackageJsonPath = resolve(happyCliDir, 'package.json');
    const hostPackageJsonRaw = readJsonSync(hostPackageJsonPath);
    const bundledDependencyNames = readBundledDependencyNames(hostPackageJsonRaw);

    // Guardrail: if plugin workspaces exist under `packages/plugins/*`, they must be explicitly
    // declared as bundled dependencies in `apps/cli/package.json`. Otherwise, they will not ship in
    // the packed artifact even if we can bundle them locally.
    const discoveredBundledPluginPackageNames = resolveDeclaredBundledPluginWorkspacePackageNames({
      repoRoot: targetRepoRoot,
    });
    const missingPluginPackages = discoveredBundledPluginPackageNames.filter(
      (packageName) => !bundledDependencyNames.includes(packageName),
    );
    if (missingPluginPackages.length > 0) {
      throw new Error(
        [
          `[bundle-workspace-deps] Missing bundled plugin workspace dependencies`,
          `These packages exist under packages/plugins/* but are not declared in apps/cli/package.json#bundledDependencies:`,
          ...missingPluginPackages.map((name) => `- ${name}`),
          ``,
          `Fix: node apps/cli/scripts/syncBundledPluginWorkspaces.mjs`,
        ].join('\n'),
      );
    }

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot: targetRepoRoot,
      hostPackageDir: happyCliDir,
    });
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
