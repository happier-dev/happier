import { resolve } from 'node:path';

import { runForegroundChild } from '../../apps/stack/scripts/utils/execution_host/foreground_child.mjs';
import { resolveAffectedDispatchArguments } from './affectedFileSelection.mjs';

try {
  const cwd = process.cwd();
  const result = await runForegroundChild({
    command: resolve(cwd, 'apps/stack/bin/hstack-exec'),
    args: ['--script=test:affected:local', ...resolveAffectedDispatchArguments(cwd, process.argv.slice(2))],
    options: { cwd, stdio: 'inherit', detached: process.platform !== 'win32' },
  });
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.exitCode ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
