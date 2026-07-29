import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

const componentDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await ensureWorkspacePackagesBuiltForComponent(componentDir, {
  quiet: false,
  env: process.env,
});
