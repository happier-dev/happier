import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBootstrapRepoRoot } from './resolveBootstrapRepoRoot.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveBootstrapRepoRoot({ startDir: scriptDir });
const invocation = resolveTypeScriptCliInvocation({
  repoRoot,
  processExecPath: process.execPath,
});

const result = spawnSync(
  invocation.command,
  [...invocation.argsPrefix, ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
