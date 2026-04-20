import { spawnDetachedInlineNodeTestProcess } from './spawn_test_process.mjs';

export function spawnDaemonLikeProcess({
  cliHomeDir,
  statePaths,
  internalServerUrl = '',
  publicServerUrl = '',
  httpPort = 1,
  startedWithCliVersion = 'test',
  env = {},
} = {}) {
  if (!cliHomeDir) {
    throw new Error('spawnDaemonLikeProcess requires cliHomeDir');
  }
  if (!Array.isArray(statePaths) || statePaths.length === 0) {
    throw new Error('spawnDaemonLikeProcess requires at least one state path');
  }

  const source = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

const payload = JSON.stringify({
  pid: process.pid,
  httpPort: ${JSON.stringify(Number(httpPort))},
  startedAt: Date.now(),
  startedWithCliVersion: ${JSON.stringify(startedWithCliVersion)},
}) + '\\n';

for (const statePath of ${JSON.stringify(statePaths)}) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, payload, 'utf-8');
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1000);
`;

  return spawnDetachedInlineNodeTestProcess(source, {
    stdio: 'ignore',
    env: {
      ...process.env,
      ...env,
      HAPPIER_HOME_DIR: cliHomeDir,
      ...(internalServerUrl ? { HAPPIER_SERVER_URL: internalServerUrl } : {}),
      ...(publicServerUrl ? { HAPPIER_WEBAPP_URL: publicServerUrl } : {}),
    },
  });
}

export function killDetachedProcessGroup(pid, signal = 'SIGTERM') {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    // ignore cleanup failures in test harnesses
  }
}
