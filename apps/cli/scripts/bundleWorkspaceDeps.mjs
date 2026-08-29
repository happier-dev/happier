import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import {
  loadCliCommonWorkspacesModule,
} from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';
import { readBundledPluginPackageNames } from './build-owned/bundledPluginMembership.ts';
import {
  formatBundledPluginArtifactVerification,
  requireBundledPluginArtifactInventory,
  verifyBundledPluginArtifactsAgainstInventory,
} from './verifyBundledPluginArtifacts.mjs';

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

function resolveDeclaredBundledPluginWorkspacePackageNames({ repoRoot }) {
  // Canonical bundled membership has one owner (bundledPluginMembership.ts). This
  // used to be a second, similar-but-different package list; the guardrails below
  // keep their pack-specific failure messages while discovery is delegated.
  return [...readBundledPluginPackageNames(repoRoot)];
}

function resolveGeneratorOwnedBundledPluginPackageNames({ repoRoot }) {
  // Fail closed with the inventory: a missing inventory must not silently re-admit
  // every generator-owned plugin to the ordinary workspace compiler (which would
  // replace the staged immutable bundle/chunk trees with compiler-owned reexports
  // before the exact verification below runs).
  const artifacts = requireBundledPluginArtifactInventory({ repoRoot }) ?? [];
  return new Set(
    artifacts
      .map((artifact) => String(artifact?.packageName ?? '').trim())
      .filter((packageName) => packageName.startsWith(PLUGINS_PACKAGE_PREFIX)),
  );
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
        publicationMode,
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
    const bundledWorkspacePackageNames = [...new Set(
      bundles.map((bundle) => String(bundle?.packageName ?? bundle?.name ?? '').trim()).filter(Boolean),
    )];
    const generatorOwnedPluginPackageNames = forceArtifactWorkspaceBuilds
      ? resolveGeneratorOwnedBundledPluginPackageNames({ repoRoot: targetRepoRoot })
      : new Set();
    // `build:shared` is the natural prepack builder and owns the full force-build
    // followed by immutable plugin runtime publication. Once its generated inventory
    // names a plugin, the pack-time copier must not admit that package to the ordinary
    // workspace compiler again: even a non-forced staleness check can replace the
    // staged bundle/chunk tree with compiler-owned reexports. The exact inventory
    // verification below is the admission check for those immutable bytes.
    const workspacePackageNamesToForceBuild = bundledWorkspacePackageNames.filter(
      (packageName) => !generatorOwnedPluginPackageNames.has(packageName),
    );
    if (workspacePackageNamesToForceBuild.length > 0) {
      await ensureWorkspacePackagesBuiltByName(
        targetRepoRoot,
        workspacePackageNamesToForceBuild,
        {
          quiet: false,
          env: heldLockEnv,
          includeDevDependencies: false,
          publicationMode,
          ...(forceArtifactWorkspaceBuilds
            ? { force: true }
            : {}),
        },
      );
    }
    bundleWorkspacePackagesWithRuntimeDependencies({
      bundles,
      publicationMode,
    });

    // Exact artifact publication is the only tree that reaches a tarball. The
    // build-owned source-integrity inventory (apps/cli/scripts/build-owned/
    // generatedBundledPluginSourceIntegrities.json) stays beside the publisher as a
    // build/pack fact: it is not part of the tarball, and the shipped runtime module
    // deliberately carries structural immutable-artifact records only — it is never a
    // digest authority. Prove the shipped plugin bytes are the ones the inventory
    // publishes before the pack step reads this tree. Live source-dev publication
    // deliberately retains prior generation targets, so it has no exact tree to
    // compare.
    if (publicationMode === 'artifact') {
      const bundledPluginPackageDirs = new Map(
        bundles.map((bundle) => [String(bundle?.packageName ?? '').trim(), bundle.destDir]),
      );
      const verification = verifyBundledPluginArtifactsAgainstInventory({
        repoRoot: targetRepoRoot,
        resolvePackageDir: (packageName) => (
          bundledPluginPackageDirs.get(packageName)
          ?? resolve(happyCliDir, 'node_modules', ...packageName.split('/'))
        ),
      });
      const failure = formatBundledPluginArtifactVerification(verification);
      if (failure) throw new Error(failure);
    }
  }, {
    repoRoot: targetRepoRoot,
    lockPath,
    env: baseEnv,
    lockTimeoutMs: DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
    lockPollIntervalMs: 250,
    lockStaleAfterMs: DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
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
