import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bundleWorkspacePackages,
  findRepoRoot,
  vendorBundledPackageRuntimeDependencies,
} from '../../../packages/cli-common/dist/workspaces/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const stackDir = opts.stackDir ?? resolve(repoRoot, 'apps', 'stack');

  const bundles = [
    {
      packageName: '@happier-dev/cli-common',
      srcDir: resolve(repoRoot, 'packages', 'cli-common'),
      destDir: resolve(stackDir, 'node_modules', '@happier-dev', 'cli-common'),
    },
    {
      packageName: '@happier-dev/release-runtime',
      srcDir: resolve(repoRoot, 'packages', 'release-runtime'),
      destDir: resolve(stackDir, 'node_modules', '@happier-dev', 'release-runtime'),
    },
  ];

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
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
