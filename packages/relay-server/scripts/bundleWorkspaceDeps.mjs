import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleWorkspacePackages, findRepoRoot } from '@happier-dev/cli-common/workspaces';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const relayDir = opts.relayDir ?? resolve(repoRoot, 'packages', 'relay-server');

  const bundles = [
    {
      packageName: '@happier-dev/release-runtime',
      srcDir: resolve(repoRoot, 'packages', 'release-runtime'),
      destDir: resolve(relayDir, 'node_modules', '@happier-dev', 'release-runtime'),
    },
  ];

  bundleWorkspacePackages({ bundles });
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

