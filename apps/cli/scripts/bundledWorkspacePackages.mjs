/**
 * Canonical list of workspace packages that are bundled into the CLI npm package.
 *
 * This module is the single source of truth consumed by both the build step
 * (`buildSharedDeps.mjs`) and the bundle step (`bundleWorkspaceDeps.mjs`).
 * Adding or removing a package here automatically keeps both steps in sync.
 */

import { resolve } from 'node:path';

/**
 * Frozen array of all workspace packages that must be compiled and bundled
 * during `yarn prepack`. Each entry is itself frozen to prevent accidental
 * mutation that could desync the derived exports.
 *
 * @type {ReadonlyArray<{dirName: string, packageName: string}>}
 */
export const bundledWorkspacePackages = Object.freeze([
  Object.freeze({ dirName: 'agents', packageName: '@happier-dev/agents' }),
  Object.freeze({ dirName: 'cli-common', packageName: '@happier-dev/cli-common' }),
  Object.freeze({ dirName: 'protocol', packageName: '@happier-dev/protocol' }),
  Object.freeze({ dirName: 'release-runtime', packageName: '@happier-dev/release-runtime' }),
]);

/**
 * Frozen array of directory names derived from {@link bundledWorkspacePackages}.
 * Matches the subdirectory names under `packages/` in the monorepo root.
 *
 * @type {ReadonlyArray<string>}
 */
export const bundledWorkspaceDirNames = Object.freeze(
  bundledWorkspacePackages.map(({ dirName }) => dirName),
);

/**
 * Frozen array of npm package names derived from {@link bundledWorkspacePackages}.
 * Must stay in sync with the `bundledDependencies` field in `apps/cli/package.json`.
 *
 * @type {ReadonlyArray<string>}
 */
export const bundledWorkspacePackageNames = Object.freeze(
  bundledWorkspacePackages.map(({ packageName }) => packageName),
);

/**
 * Creates the bundle descriptor objects used by `bundleWorkspaceDeps.mjs`.
 * Each descriptor maps a workspace package to its source directory (in the
 * monorepo) and the destination directory under `apps/cli/node_modules`.
 *
 * @param {{ repoRoot: string, happyCliDir: string }} opts
 * @returns {Array<{ packageName: string, srcDir: string, destDir: string }>}
 */
export function createBundledWorkspaceBundles({ repoRoot, happyCliDir }) {
  return bundledWorkspacePackages.map(({ dirName, packageName }) => ({
    packageName,
    srcDir: resolve(repoRoot, 'packages', dirName),
    destDir: resolve(happyCliDir, 'node_modules', '@happier-dev', dirName),
  }));
}
