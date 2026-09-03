import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHeartbeatArgs, resolveSignalExitCode, runHeartbeatWrappedCommand } from './runPlaywrightWithHeartbeat.shared.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '../../..');
const require = createRequire(import.meta.url);

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-vitest-with-heartbeat.mjs --config <vitest.config.ts> [extra args]');
  process.exit(2);
}

const vitestEntrypoint = process.env.HAPPIER_TEST_VITEST_ENTRYPOINT || require.resolve('vitest/vitest.mjs');
const diagnosticPath = process.env.HAPPIER_CI_DIAGNOSTIC_PATH
  || resolve(repoRoot, '.project/logs/e2e/vitest-heartbeat-diagnostic.ndjson');
const reporterPath = resolve(scriptsDir, 'vitestHeartbeatReporter.mjs');
const childArgs = [
  vitestEntrypoint,
  'run',
  '--no-file-parallelism',
  '-c',
  config,
  '--reporter=default',
  `--reporter=${reporterPath}`,
  ...passThrough,
];

await runHeartbeatWrappedCommand({
  toolName: 'vitest',
  config,
  diagnosticPath,
  command: process.execPath,
  args: childArgs,
  spawnOptions: {
    stdio: 'inherit',
    env: {
      ...process.env,
      HAPPIER_CI_DIAGNOSTIC_PATH: diagnosticPath,
    },
  },
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
