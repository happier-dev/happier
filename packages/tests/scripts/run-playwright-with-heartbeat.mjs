import { parseHeartbeatArgs, resolveHeartbeatMs, runHeartbeatCommand } from './runPlaywrightWithHeartbeat.shared.mjs';

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-playwright-with-heartbeat.mjs --config <playwright.config.mjs> [extra args]');
  process.exit(2);
}

const exitCode = await runHeartbeatCommand({
  childArgs: ['-s', 'playwright', 'test', '-c', config, ...passThrough],
  env: process.env,
  heartbeatMs: resolveHeartbeatMs(process.env.HAPPIER_TEST_HEARTBEAT_MS),
  label: config,
  startupLabel: 'playwright',
});

process.exit(exitCode);
