import {
  createPlaywrightSpawnOptions,
  parseHeartbeatArgs,
  runHeartbeatWrappedCommand,
  resolveSignalExitCode,
} from './runPlaywrightWithHeartbeat.shared.mjs';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { resolvePlaywrightWrapperTimeoutFallbackMs } from './playwrightWrapperTimeout.mjs';

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-playwright-with-heartbeat.mjs --config <playwright.config.mjs> [extra args]');
  process.exit(2);
}

const childArgs = ['-s', 'playwright', 'test', '-c', config, ...passThrough];
const invocation = resolveYarnCommandInvocation(childArgs, { npmExecPath: '' });

await runHeartbeatWrappedCommand({
  toolName: 'playwright',
  config,
  command: invocation.command,
  args: invocation.args,
  spawnOptions: {
    ...createPlaywrightSpawnOptions(process.env),
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  },
  defaultTimeoutMs: resolvePlaywrightWrapperTimeoutFallbackMs(process.env),
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
