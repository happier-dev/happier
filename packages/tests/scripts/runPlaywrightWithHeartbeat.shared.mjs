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
    if (typeof arg === 'string' && arg.startsWith('--config=')) {
      config = arg.slice('--config='.length) || null;
      continue;
    }
    passThrough.push(arg);
  }

  return { config, passThrough };
}

export function createPlaywrightSpawnOptions(env) {
  return {
    stdio: 'inherit',
    env,
    detached: process.platform !== 'win32',
  };
}

export function resolveSignalExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGHUP') return 129;
  return 1;
}
