import { spawnSync } from 'node:child_process';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

const invocation = resolveTypeScriptCliInvocation({
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
