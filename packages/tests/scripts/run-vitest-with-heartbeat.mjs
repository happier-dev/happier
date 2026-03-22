import { parseHeartbeatArgs, resolveSignalExitCode, runHeartbeatWrappedCommand } from './runPlaywrightWithHeartbeat.shared.mjs';

function yarnCommand() {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-vitest-with-heartbeat.mjs --config <vitest.config.ts> [extra args]');
  process.exit(2);
}

const childArgs = ['-s', 'vitest', 'run', '--no-file-parallelism', '-c', config, ...passThrough];

await runHeartbeatWrappedCommand({
  toolName: 'vitest',
  config,
  command: yarnCommand(),
  args: childArgs,
  spawnOptions: {
    stdio: 'inherit',
    env: process.env,
  },
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
