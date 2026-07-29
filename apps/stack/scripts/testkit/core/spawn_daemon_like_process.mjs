import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnDetachedTestProcess } from './spawn_test_process.mjs';

const DEFAULT_CONTROL_TOKEN = 'happier-test-daemon-control';
const STATE_PATHS_ENV = 'HAPPIER_TEST_DAEMON_STATE_PATHS_JSON';
const START_DELAY_ENV = 'HAPPIER_TEST_DAEMON_START_DELAY_MS';
const HTTP_PORT_ENV = 'HAPPIER_TEST_DAEMON_HTTP_PORT';
const CLI_VERSION_ENV = 'HAPPIER_TEST_DAEMON_CLI_VERSION';
const DIST_CLOSURE_FINGERPRINT_ENV = 'HAPPIER_TEST_DAEMON_DIST_CLOSURE_FINGERPRINT';

function normalizeStatePaths(statePaths) {
  if (!Array.isArray(statePaths) || statePaths.length === 0) {
    throw new Error('daemon-like test process requires at least one state path');
  }
  return statePaths.map((path) => String(path ?? '').trim()).filter(Boolean);
}

function normalizeNonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeFingerprint(value) {
  const fingerprint = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{16}$/.test(fingerprint) ? fingerprint : null;
}

export async function startDaemonLikeProcess({
  statePaths,
  httpPort = 0,
  startDelayMs = 0,
  startedWithCliVersion = 'test',
  controlToken = DEFAULT_CONTROL_TOKEN,
  distClosureFingerprint = null,
} = {}) {
  const paths = normalizeStatePaths(statePaths);
  const admittedFingerprint = normalizeFingerprint(distClosureFingerprint);
  const delayMs = normalizeNonNegativeNumber(startDelayMs);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const server = createServer((req, res) => {
    const authenticated = req.headers['x-happier-daemon-token'] === controlToken;
    if (req.method === 'POST' && req.url === '/ping' && authenticated) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ...(admittedFingerprint ? { distClosureFingerprint: admittedFingerprint } : {}),
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/stop' && authenticated) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      res.once('finish', () => server.close());
      return;
    }
    if (req.method === 'POST' && req.url === '/restart' && authenticated) {
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { rawBody += chunk; });
      req.on('end', () => {
        let body = {};
        try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
        spawnDaemonLikeProcess({
          cliHomeDir: process.env.HAPPIER_HOME_DIR,
          statePaths: paths,
          internalServerUrl: process.env.HAPPIER_SERVER_URL,
          publicServerUrl: process.env.HAPPIER_WEBAPP_URL,
          startedWithCliVersion,
          distClosureFingerprint: body.successorDistClosureFingerprint ?? admittedFingerprint,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'restarting' }));
        res.once('finish', () => server.close());
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(normalizeNonNegativeNumber(httpPort), '127.0.0.1', resolve);
  });

  const address = server.address();
  const boundPort = address && typeof address === 'object' ? Number(address.port) : 0;
  const payload = JSON.stringify({
    pid: process.pid,
    httpPort: boundPort,
    controlToken,
    startedAt: Date.now(),
    startedWithCliVersion,
  }) + '\n';

  for (const statePath of paths) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, payload, 'utf-8');
  }

  return { server, statePaths: paths, httpPort: boundPort, controlToken };
}

export function spawnDaemonLikeProcess({
  cliHomeDir,
  statePaths,
  internalServerUrl = '',
  publicServerUrl = '',
  httpPort = 0,
  startDelayMs = 0,
  startedWithCliVersion = 'test',
  distClosureFingerprint = null,
  env = {},
} = {}) {
  if (!cliHomeDir) {
    throw new Error('spawnDaemonLikeProcess requires cliHomeDir');
  }
  const paths = normalizeStatePaths(statePaths);

  return spawnDetachedTestProcess(
    process.execPath,
    [fileURLToPath(import.meta.url), 'daemon', 'start-sync'],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        ...env,
        HAPPIER_HOME_DIR: cliHomeDir,
        [STATE_PATHS_ENV]: JSON.stringify(paths),
        [START_DELAY_ENV]: String(normalizeNonNegativeNumber(startDelayMs)),
        [HTTP_PORT_ENV]: String(normalizeNonNegativeNumber(httpPort)),
        [CLI_VERSION_ENV]: String(startedWithCliVersion ?? 'test'),
        [DIST_CLOSURE_FINGERPRINT_ENV]: String(distClosureFingerprint ?? ''),
        ...(internalServerUrl ? { HAPPIER_SERVER_URL: internalServerUrl } : {}),
        ...(publicServerUrl ? { HAPPIER_WEBAPP_URL: publicServerUrl } : {}),
      },
    },
  );
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

async function runAsDaemonFixtureProcess() {
  let statePaths = [];
  try {
    statePaths = JSON.parse(String(process.env[STATE_PATHS_ENV] ?? '[]'));
  } catch {
    statePaths = [];
  }
  const { server } = await startDaemonLikeProcess({
    statePaths,
    startDelayMs: process.env[START_DELAY_ENV],
    httpPort: process.env[HTTP_PORT_ENV],
    startedWithCliVersion: process.env[CLI_VERSION_ENV],
    distClosureFingerprint: process.env[DIST_CLOSURE_FINGERPRINT_ENV],
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedAsScript = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  await runAsDaemonFixtureProcess();
}
