import { parseHeartbeatArgs, resolveHeartbeatMs, runHeartbeatCommand } from './runPlaywrightWithHeartbeat.shared.mjs';

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-vitest-with-heartbeat.mjs --config <vitest.config.ts> [extra args]');
  process.exit(2);
}

const exitCode = await runHeartbeatCommand({
  childArgs: ['-s', 'vitest', 'run', '--no-file-parallelism', '-c', config, ...passThrough],
  env: process.env,
  heartbeatMs: resolveHeartbeatMs(process.env.HAPPIER_TEST_HEARTBEAT_MS),
  label: config,
  startupLabel: 'vitest',
});

process.exit(exitCode);
