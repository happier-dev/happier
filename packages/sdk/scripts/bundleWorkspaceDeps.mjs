import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bundleWorkspacePackageDependencies,
  findWorkspaceRepositoryRoot,
} from '../../../scripts/workspaces/bundleWorkspacePackageDependencies.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findWorkspaceRepositoryRoot(__dirname);

await bundleWorkspacePackageDependencies({
  repoRoot,
  hostPackageDir: resolve(repoRoot, 'packages', 'sdk'),
  publicationMode: resolveWorkspaceBundlePublicationMode({
    argv: process.argv.slice(2),
    env: process.env,
  }),
  quiet: true,
});
