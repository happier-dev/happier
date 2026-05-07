import { parseHeartbeatArgs, resolveSignalExitCode, runHeartbeatWrappedCommand } from './runPlaywrightWithHeartbeat.shared.mjs';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-vitest-with-heartbeat.mjs --config <vitest.config.ts> [extra args]');
  process.exit(2);
}

const childArgs = ['-s', 'vitest', 'run', '--no-file-parallelism', '-c', config, ...passThrough];
const invocation = resolveYarnCommandInvocation(childArgs);

await runHeartbeatWrappedCommand({
  toolName: 'vitest',
  config,
  command: invocation.command,
  args: invocation.args,
  spawnOptions: {
    stdio: 'inherit',
    env: process.env,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  },
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
