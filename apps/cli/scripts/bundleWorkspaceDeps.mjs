import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bundleWorkspacePackages,
  findRepoRoot,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from '../../../packages/cli-common/dist/workspaces/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const happyCliDir = opts.happyCliDir ?? resolve(repoRoot, 'apps', 'cli');

  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: happyCliDir,
  });
  bundleWorkspacePackages({ bundles });

  for (const b of bundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: resolve(b.srcDir, 'package.json'),
      destPackageDir: b.destDir,
    });
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    bundleWorkspaceDeps();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
