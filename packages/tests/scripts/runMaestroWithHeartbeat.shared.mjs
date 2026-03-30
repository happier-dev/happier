import { runHeartbeatWrappedCommand, resolveSignalExitCode } from './runPlaywrightWithHeartbeat.shared.mjs';

export { runHeartbeatWrappedCommand, resolveSignalExitCode };

export function parseMaestroArgs(argv) {
  const args = argv.slice(2);
  let flows = null;
  let appId = null;
  let platform = null;
  let serverUrl = null;
  let skipAppInstallCheck = false;
  const passThrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--flows') {
      flows = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--flows=')) {
      flows = arg.slice('--flows='.length) || null;
      continue;
    }
    if (arg === '--appId') {
      appId = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--appId=')) {
      appId = arg.slice('--appId='.length) || null;
      continue;
    }
    if (arg === '--platform') {
      platform = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--platform=')) {
      platform = arg.slice('--platform='.length) || null;
      continue;
    }
    if (arg === '--serverUrl') {
      serverUrl = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--serverUrl=')) {
      serverUrl = arg.slice('--serverUrl='.length) || null;
      continue;
    }
    if (arg === '--skip-app-install-check') {
      skipAppInstallCheck = true;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--skip-app-install-check=')) {
      const raw = arg.slice('--skip-app-install-check='.length).trim().toLowerCase();
      skipAppInstallCheck = raw === '' || raw === '1' || raw === 'true' || raw === 'yes';
      continue;
    }
    passThrough.push(arg);
  }

  return { flows, appId, platform, serverUrl, skipAppInstallCheck, passThrough };
}

export function createMaestroSpawnOptions(env) {
  const nextEnv = {
    ...env,
    // Disable analytics prompts for CI and deterministic local runs.
    // (Maestro also supports explicit `maestro --disable-analytics` in some versions; env is more portable.)
    MAESTRO_CLI_NO_ANALYTICS: String(env?.MAESTRO_CLI_NO_ANALYTICS ?? '1'),
  };

  return {
    stdio: 'inherit',
    env: nextEnv,
    detached: process.platform !== 'win32',
  };
}
