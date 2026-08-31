import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import {
  createPlaywrightSpawnOptions,
  parseHeartbeatArgs,
  runHeartbeatWrappedCommand,
  resolveSignalExitCode,
} from './runPlaywrightWithHeartbeat.shared.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '../../..');

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-playwright-with-heartbeat.mjs --config <playwright.config.mjs> [extra args]');
  process.exit(2);
}

const childArgs = ['-s', 'playwright', 'test', '-c', config, ...passThrough];
const invocation = resolveYarnCommandInvocation(childArgs);

await runHeartbeatWrappedCommand({
  toolName: 'playwright',
  config,
  diagnosticPath: process.env.HAPPIER_CI_DIAGNOSTIC_PATH
    || resolve(repoRoot, '.project/logs/e2e/playwright-heartbeat-diagnostic.ndjson'),
  command: invocation.command,
  args: invocation.args,
  spawnOptions: {
    ...createPlaywrightSpawnOptions(process.env),
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  },
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
