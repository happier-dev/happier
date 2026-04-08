import {
  createPlaywrightSpawnOptions,
  parseHeartbeatArgs,
  runHeartbeatWrappedCommand,
  resolveSignalExitCode,
} from './runPlaywrightWithHeartbeat.shared.mjs';

const DEFAULT_PLAYWRIGHT_WRAPPER_TIMEOUT_MS = 15 * 60 * 1000;

function yarnCommand() {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-playwright-with-heartbeat.mjs --config <playwright.config.mjs> [extra args]');
  process.exit(2);
}

const childArgs = ['-s', 'playwright', 'test', '-c', config, ...passThrough];

await runHeartbeatWrappedCommand({
  toolName: 'playwright',
  config,
  command: yarnCommand(),
  args: childArgs,
  spawnOptions: createPlaywrightSpawnOptions(process.env),
  defaultTimeoutMs: DEFAULT_PLAYWRIGHT_WRAPPER_TIMEOUT_MS,
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
