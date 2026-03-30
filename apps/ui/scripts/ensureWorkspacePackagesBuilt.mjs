import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault } from '../../stack/scripts/utils/proc/pm.mjs';

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));

export async function ensureUiWorkspacePackagesBuilt({
  env = process.env,
  ensureWorkspacePackagesBuiltForComponent = ensureWorkspacePackagesBuiltForComponentDefault,
} = {}) {
  const result = await ensureWorkspacePackagesBuiltForComponent(uiDir, { quiet: false, env });
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  if (skipped.includes('not-monorepo')) {
    throw new Error('[ui] ensure:workspace:built failed (not-monorepo): apps/ui must be run from inside the Happier monorepo checkout.');
  }
  return result;
}

async function run() {
  await ensureUiWorkspacePackagesBuilt();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
