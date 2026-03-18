import { spawn } from 'node:child_process';

export function yarnCommand() {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

export function parseHeartbeatArgs(argv) {
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

export function resolveHeartbeatMs(raw) {
  const heartbeatMs = Number.parseInt(String(raw ?? '30000'), 10);
  return Number.isFinite(heartbeatMs) && heartbeatMs >= 1000 ? heartbeatMs : 30000;
}

function elapsedSeconds(startedAtMs) {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

export async function runHeartbeatCommand(params) {
  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[tests] starting: yarn ${params.childArgs.join(' ')}`);

  const child = spawn(yarnCommand(), params.childArgs, {
    stdio: 'inherit',
    env: params.env,
    detached: process.platform !== 'win32',
  });

  const heartbeat = setInterval(() => {
    // eslint-disable-next-line no-console
    console.log(`[tests] still running (${elapsedSeconds(startedAt)}s elapsed): ${params.label}`);
  }, params.heartbeatMs);

  let finished = false;
  const clearHeartbeat = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }

  return await new Promise((resolve) => {
    child.once('error', (error) => {
      clearHeartbeat();
      // eslint-disable-next-line no-console
      console.error(`[tests] failed to start ${params.startupLabel}: ${error.message}`);
      resolve(1);
    });

    child.once('exit', (code, signal) => {
      clearHeartbeat();
      const exitCode = typeof code === 'number' ? code : signal ? 128 : 1;
      // eslint-disable-next-line no-console
      console.log(`[tests] completed in ${elapsedSeconds(startedAt)}s with code ${exitCode}`);
      resolve(exitCode);
    });
  });
}
