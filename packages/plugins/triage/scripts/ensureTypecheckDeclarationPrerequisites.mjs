import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault,
} from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRepoRoot = resolve(packageRoot, '../../..');

// This TypeScript project keeps its package boundary: its production source
// imports these public package exports, whose declarations cannot be included
// under this package's rootDir. This is intentionally not a source resolver or
// a runtime/plugin publication path.
export const TYPECHECK_DECLARATION_PREREQUISITES = Object.freeze([
  '@happier-dev/plugin-sdk',
  '@happier-dev/plugin-ui',
  '@happier-dev/triage-protocol',
]);

export async function ensureTypecheckDeclarationPrerequisites({
  repoRoot = defaultRepoRoot,
  env = process.env,
  quiet = false,
  ensureWorkspacePackagesBuiltByName = ensureWorkspacePackagesBuiltByNameDefault,
} = {}) {
  return await ensureWorkspacePackagesBuiltByName(repoRoot, TYPECHECK_DECLARATION_PREREQUISITES, {
    env,
    includeDevDependencies: false,
    quiet,
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  return Boolean(argv1) && resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    await ensureTypecheckDeclarationPrerequisites();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
