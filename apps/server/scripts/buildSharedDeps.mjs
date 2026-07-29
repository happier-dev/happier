import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault } from '../../stack/scripts/utils/proc/pm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, '..');

export async function prepareServerWorkspacePrerequisites({
  env = process.env,
  quiet = process.argv.includes('--quiet') || process.argv.includes('-s'),
  ensureWorkspacePackagesBuiltForComponent = ensureWorkspacePackagesBuiltForComponentDefault,
} = {}) {
  return await ensureWorkspacePackagesBuiltForComponent(serverDir, { env, quiet });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareServerWorkspacePrerequisites();
}
