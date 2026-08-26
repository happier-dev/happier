#!/usr/bin/env node

import './utils/env/env.mjs';

import { readExecutionHostProfile } from './utils/execution_host/config.mjs';
import { runExecutionHostBridge } from './utils/execution_host/bridge.mjs';

function optionValue(argv, name) {
  const inline = argv.find((argument) => String(argument).startsWith(`${name}=`));
  if (inline) return String(inline).slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] ?? '') : '';
}

async function main() {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  if (separator < 0) throw new Error('[execution-host] bridge requires -- before the repo-local arguments');
  const workspaceId = optionValue(argv.slice(0, separator), '--workspace-id').trim();
  const localEntrypoint = optionValue(argv.slice(0, separator), '--local-entrypoint').trim();
  if (!workspaceId) throw new Error('[execution-host] bridge requires --workspace-id=ID');
  const outcome = await runExecutionHostBridge({
    profile: readExecutionHostProfile(process.env),
    workspaceId,
    localEntrypoint,
    argv: argv.slice(separator + 1),
    cwd: process.cwd(),
    env: process.env,
  });
  if (outcome.signal) {
    process.kill(process.pid, outcome.signal);
    return;
  }
  process.exitCode = outcome.exitCode ?? 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
