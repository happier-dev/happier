import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveServerRepoRoot } from './resolveServerRepoRoot.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveServerRepoRoot({ startDir: scriptDir });
const serverRoot = resolve(scriptDir, '..');
const invocation = resolveTypeScriptCliInvocation({
  repoRoot,
  processExecPath: process.execPath,
});

const result = spawnSync(invocation.command, [...invocation.argsPrefix, ...process.argv.slice(2)], {
  cwd: serverRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
