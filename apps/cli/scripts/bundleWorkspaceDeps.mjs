import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import {
  loadCliCommonWorkspacesModule,
} from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';

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

export { loadCliCommonWorkspacesModule };

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
  const lockPath = opts.lockPath ?? resolveCliSharedDepsBuildLockPath(targetRepoRoot);

  const baseEnv = opts.env ?? process.env;
  const publicationMode = opts.publicationMode ?? 'live';
  const forceArtifactWorkspaceBuilds = publicationMode === 'artifact';
  const ensureWorkspacePackagesBuiltByName = opts.ensureWorkspacePackagesBuiltByName
    ?? ensureWorkspacePackagesBuiltByNameDefault;
  return withOptionalCliSharedDepsBuildLock(async ({ heldLockValue } = {}) => {
    const heldLockEnv = createWorkspaceChildBuildEnv({
      env: baseEnv,
      heldLockValue,
    });
    const {
      bundleWorkspacePackagesWithRuntimeDependencies,
      readBundledWorkspacePackageNames,
      resolveWorkspaceBundlesFromPackageJson,
    } = await loadCliCommonWorkspacesModule(
      SCRIPT_REPO_ROOT,
      heldLockEnv,
      ensureWorkspacePackagesBuiltByName,
      {
        force: forceArtifactWorkspaceBuilds,
        includeDevDependencies: false,
      },
    );

    const hostPackageJsonPath = resolve(happyCliDir, 'package.json');
    const hostPackageJsonRaw = readJsonSync(hostPackageJsonPath);
    const bundledDependencyNames = readBundledDependencyNames(hostPackageJsonRaw);
    const runtimeDependencyNames = new Set(
      hostPackageJsonRaw?.dependencies
      && typeof hostPackageJsonRaw.dependencies === 'object'
      && !Array.isArray(hostPackageJsonRaw.dependencies)
        ? Object.keys(hostPackageJsonRaw.dependencies)
        : [],
    );

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
          `Fix: node --experimental-strip-types scripts/migrations/extensions/syncCliBundledExtensionPackaging.ts --mode write`,
        ].join('\n'),
      );
    }
    const missingRuntimePluginPackages = discoveredBundledPluginPackageNames.filter(
      (packageName) => !runtimeDependencyNames.has(packageName),
    );
    if (missingRuntimePluginPackages.length > 0) {
      throw new Error(
        [
          `[bundle-workspace-deps] Missing CLI runtime dependencies for bundled plugin workspaces`,
          `These shippable packages must be declared in both apps/cli/package.json#bundledDependencies and #dependencies:`,
          ...missingRuntimePluginPackages.map((name) => `- ${name}`),
          ``,
          `Fix: node --experimental-strip-types scripts/migrations/extensions/syncCliBundledExtensionPackaging.ts --mode write`,
        ].join('\n'),
      );
    }

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot: targetRepoRoot,
      hostPackageDir: happyCliDir,
    });
    await ensureWorkspacePackagesBuiltByName(
      targetRepoRoot,
      [...new Set(bundles.map((bundle) => String(bundle?.packageName ?? bundle?.name ?? '').trim()).filter(Boolean))],
      {
        quiet: false,
        env: heldLockEnv,
        includeDevDependencies: false,
        ...(forceArtifactWorkspaceBuilds
          ? { force: true }
          : {}),
      },
    );
    bundleWorkspacePackagesWithRuntimeDependencies({
      bundles,
      publicationMode,
    });
  }, {
    repoRoot: targetRepoRoot,
    lockPath,
    env: baseEnv,
    lockTimeoutMs: 240_000,
    lockPollIntervalMs: 250,
    lockStaleAfterMs: 240_000,
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
