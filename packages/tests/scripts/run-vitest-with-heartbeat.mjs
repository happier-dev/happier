import { spawn } from 'node:child_process';

function yarnCommand() {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let config = null;
  const passThrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      config = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    passThrough.push(arg);
  }

  return { config, passThrough };
}

function elapsedSeconds(startedAtMs) {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

const { config, passThrough } = parseArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-vitest-with-heartbeat.mjs --config <vitest.config.ts> [extra args]');
  process.exit(2);
}

const heartbeatMs = Number.parseInt(process.env.HAPPIER_TEST_HEARTBEAT_MS ?? '30000', 10);
const safeHeartbeatMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 1000 ? heartbeatMs : 30000;
const startedAt = Date.now();

const childArgs = ['-s', 'vitest', 'run', '--no-file-parallelism', '-c', config, ...passThrough];
// eslint-disable-next-line no-console
console.log(`[tests] starting: yarn ${childArgs.join(' ')}`);

const child = spawn(yarnCommand(), childArgs, {
  stdio: 'inherit',
  env: process.env,
  detached: process.platform !== 'win32',
});

const heartbeat = setInterval(() => {
  // eslint-disable-next-line no-console
  console.log(`[tests] still running (${elapsedSeconds(startedAt)}s elapsed): ${config}`);
}, safeHeartbeatMs);

let finished = false;
function clearHeartbeat() {
  if (finished) return;
  finished = true;
  clearInterval(heartbeat);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.once('error', (error) => {
  clearHeartbeat();
  // eslint-disable-next-line no-console
  console.error(`[tests] failed to start vitest: ${error.message}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  clearHeartbeat();
  const exitCode = typeof code === 'number' ? code : (signal ? 128 : 1);
  // eslint-disable-next-line no-console
  console.log(`[tests] completed in ${elapsedSeconds(startedAt)}s with code ${exitCode}`);
  process.exit(exitCode);
});
