import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bundleWorkspacePackageDependencies,
  findWorkspaceRepositoryRoot,
} from '../../../scripts/workspaces/bundleWorkspacePackageDependencies.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function bundleWorkspaceDeps(options = {}) {
  const repoRoot = options.repoRoot ?? findWorkspaceRepositoryRoot(__dirname);
  return await bundleWorkspacePackageDependencies({
    ...options,
    repoRoot,
    hostPackageDir: options.supportDir ?? resolve(repoRoot, 'packages', 'support'),
    quiet: false,
  });
}

const invokedAsMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

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
