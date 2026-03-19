import { spawn } from 'node:child_process';

import {
  createPlaywrightSpawnOptions,
  parseHeartbeatArgs,
  resolveSignalExitCode,
} from './runPlaywrightWithHeartbeat.shared.mjs';
import { terminateProcessTreeByPid } from './processTree.mjs';

function yarnCommand() {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

function elapsedSeconds(startedAtMs) {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-playwright-with-heartbeat.mjs --config <playwright.config.mjs> [extra args]');
  process.exit(2);
}

const heartbeatMs = Number.parseInt(process.env.HAPPIER_TEST_HEARTBEAT_MS ?? '30000', 10);
const safeHeartbeatMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 1000 ? heartbeatMs : 30000;
const startedAt = Date.now();

const childArgs = ['-s', 'playwright', 'test', '-c', config, ...passThrough];
// eslint-disable-next-line no-console
console.log(`[tests] starting: yarn ${childArgs.join(' ')}`);

const child = spawn(yarnCommand(), childArgs, createPlaywrightSpawnOptions(process.env));

const heartbeat = setInterval(() => {
  // eslint-disable-next-line no-console
  console.log(`[tests] still running (${elapsedSeconds(startedAt)}s elapsed): ${config}`);
}, safeHeartbeatMs);

let finished = false;
let cleanupStarted = false;
function clearHeartbeat() {
  if (finished) return;
  finished = true;
  clearInterval(heartbeat);
}

async function cleanupChild(signal) {
  if (cleanupStarted) return;
  cleanupStarted = true;

  if (typeof child.pid === 'number' && child.pid > 0) {
    await terminateProcessTreeByPid(child.pid, { graceMs: 0, pollMs: 25 });
    return;
  }

  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void cleanupChild(signal);
  });
}

child.once('error', (error) => {
  clearHeartbeat();
  // eslint-disable-next-line no-console
  console.error(`[tests] failed to start playwright: ${error.message}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  clearHeartbeat();
  const exitCode = typeof code === 'number' ? code : resolveSignalExitCode(signal);
  // eslint-disable-next-line no-console
  console.log(`[tests] completed in ${elapsedSeconds(startedAt)}s with code ${exitCode}`);
  process.exit(exitCode);
});
