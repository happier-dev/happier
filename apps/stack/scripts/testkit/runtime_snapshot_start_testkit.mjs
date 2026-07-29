import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStackCredentialPaths } from '../utils/auth/credentials_paths.mjs';
import { buildStackStableScopeId } from '../utils/auth/stable_scope_id.mjs';
import { pickNextFreeTcpPort } from '../utils/net/ports.mjs';
import { runNodeCapture } from './core/run_node_capture.mjs';
import { writeRuntimeSnapshotLayout } from './core/runtime_snapshot_layout.mjs';
import { writeStubHappierCliFiles } from './core/stub_happier_cli_files.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export const runNode = runNodeCapture;

const DAEMON_LIKE_PROCESS_HELPER_PATH = fileURLToPath(
  new URL('./core/spawn_daemon_like_process.mjs', import.meta.url),
);
const DAEMON_STATE_PATHS_HELPER_PATH = fileURLToPath(
  new URL('../utils/auth/credentials_paths.mjs', import.meta.url),
);

export async function waitForHealth(baseUrl, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json().catch(() => null);
      if (res.status === 200 && body?.status === 'ok') return;
      lastError = `status=${res.status} body=${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health (${lastError})`);
}

function createFixtureDaemonCliScript({
  startLogLine,
  statusLogLine,
  includeServerUrlInStartLog = false,
  includeRunningInStatusLog = false,
}) {
  return `
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killDetachedProcessGroup, spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_LIKE_PROCESS_HELPER_PATH)};
import { resolveStackDaemonStatePaths } from ${JSON.stringify(DAEMON_STATE_PATHS_HELPER_PATH)};

const args = process.argv.slice(2);
const home = String(process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR || '').trim();
if (!home) {
  console.error('missing HAPPIER_HOME_DIR');
  process.exit(2);
}
const resolvedStatePaths = resolveStackDaemonStatePaths({
  cliHomeDir: home,
  serverUrl: String(process.env.HAPPIER_SERVER_URL || ''),
  env: process.env,
});
const statePaths = [...new Set(resolvedStatePaths.pairs.map((pair) => pair.statePath).filter(Boolean))];
const logPath = join(home, 'runtime-daemon.log');
const append = (line) => {
  writeFileSync(logPath, line + '\\n', { flag: 'a' });
};
const removeState = () => {
  for (const path of statePaths) {
    try { rmSync(path); } catch {}
  }
};
if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'start') {
  ${includeServerUrlInStartLog
    ? "append('start:' + String(process.env.HAPPIER_SERVER_URL || ''));"
    : `append(${JSON.stringify(startLogLine)});`}
  append('direct_peer_bind_port=' + String(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT || ''));
  append('direct_peer_advertised_hosts=' + String(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS || ''));
  append('direct_peer_feature_enabled=' + String(process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED || ''));
  append('direct_peer_server_enabled=' + String(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED || ''));
  spawnDaemonLikeProcess({
    cliHomeDir: home,
    statePaths,
    internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
    publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
    distClosureFingerprint: process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT,
  });
  const readyDeadline = Date.now() + 5_000;
  while (!statePaths.every((path) => existsSync(path)) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!statePaths.every((path) => existsSync(path))) {
    console.error('daemon fixture failed to publish control state');
    process.exit(2);
  }
  process.exit(0);
}
if (sub === 'stop') {
  append('stop');
  const existingStatePath = statePaths.find((path) => existsSync(path));
  if (existingStatePath) {
    try {
      const pid = Number(JSON.parse(readFileSync(existingStatePath, 'utf8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        killDetachedProcessGroup(pid);
      }
    } catch {}
  }
  removeState();
  process.exit(0);
}
if (sub === 'status') {
  const running = statePaths.some((path) => existsSync(path));
  ${includeRunningInStatusLog
    ? `append(${JSON.stringify(statusLogLine)} + String(running));`
    : `append(${JSON.stringify(statusLogLine)});`}
  console.log(running ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}
process.exit(0);
`;
}

export async function createStartableRuntimeSnapshotFixture(t, {
  stackName = 'runtime-prod',
  serverPort,
  serverReadyDelayMs = 0,
  listenerDiscoveryMode = null,
  serverComponent = 'happier-server-light',
  runtimeMigration = 'success',
} = {}) {
  const preserveFixture = (process.env.HAPPIER_TEST_PRESERVE_RUNTIME_FIXTURE ?? '').toString().trim() === '1';
  const fixture = await createTempFixture(t, {
    prefix: 'hstack-runtime-start-fixture-',
    registerCleanup: !preserveFixture,
  });
  const resolvedServerPort =
    Number.isFinite(serverPort) && Number(serverPort) > 0
      ? Number(serverPort)
      : await pickNextFreeTcpPort(20_000, { host: '127.0.0.1' });
  const root = fixture.root;
  const storageDir = join(root, 'storage');
  const stackDir = join(storageDir, stackName);
  const cliHomeDir = join(stackDir, 'cli');
  const runtimeDir = join(stackDir, 'runtime');
  const serverEnvCapturePath = join(stackDir, 'server.runtime-env.json');
  const serverPidCapturePath = join(stackDir, 'server.pid.capture');
  const listenerDiscoveryLogPath = join(stackDir, 'listener-discovery.log');
  const runtimeServerEventLogPath = join(stackDir, 'runtime-server-events.log');
  const daemonDistClosureFingerprint = '0123456789abcdef';

  await mkdir(cliHomeDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const serverScript = `
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.PORT || process.env.HAPPIER_SERVER_PORT || 0);
if (!Number.isFinite(port) || port <= 0) {
  console.error('missing HAPPIER_SERVER_PORT');
  process.exit(2);
}
const uiDir = String(process.env.HAPPIER_SERVER_UI_DIR || '').trim();
const marker = String(process.env.HAPPIER_RUNTIME_SNAPSHOT_MARKER || 'runtime-snapshot');
const envCapturePath = String(process.env.HAPPIER_RUNTIME_SERVER_ENV_CAPTURE_PATH || '').trim();
const pidCapturePath = String(process.env.HAPPIER_TEST_SERVER_PID_CAPTURE_PATH || '').trim();
const eventLogPath = String(process.env.HAPPIER_TEST_RUNTIME_SERVER_EVENT_LOG || ${JSON.stringify(serverComponent === 'happier-server' ? runtimeServerEventLogPath : '')}).trim();
if (eventLogPath) appendFileSync(eventLogPath, 'server\\n', 'utf8');
if (envCapturePath) {
  writeFileSync(envCapturePath, JSON.stringify({
    DATABASE_URL: process.env.DATABASE_URL ?? null,
    HAPPIER_SQLITE_AUTO_MIGRATE: process.env.HAPPIER_SQLITE_AUTO_MIGRATE ?? null,
    HAPPIER_SQLITE_MIGRATIONS_DIR: process.env.HAPPIER_SQLITE_MIGRATIONS_DIR ?? null,
    HAPPIER_SERVER_LIGHT_DATA_DIR: process.env.HAPPIER_SERVER_LIGHT_DATA_DIR ?? null,
  }, null, 2) + '\\n', 'utf8');
}
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/health' || url.pathname === '/ready') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'happier-server', status: 'ok', marker }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = uiDir
      ? readFileSync(join(uiDir, 'index.html'), 'utf8')
      : '<!doctype html><html><body>runtime server fixture</body></html>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const startServer = () => {
  server.listen(port, '127.0.0.1', () => {
    if (pidCapturePath) writeFileSync(pidCapturePath, String(process.pid) + '\\n', 'utf8');
    console.log('runtime-server-ready:' + port);
  });
};
const readyDelayMs = ${JSON.stringify(Math.max(0, Number(serverReadyDelayMs) || 0))};
if (readyDelayMs > 0) {
  setTimeout(startServer, readyDelayMs);
} else {
  startServer();
}

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

  const cliScript = createFixtureDaemonCliScript({
    startLogLine: 'start',
    statusLogLine: 'status:',
    includeServerUrlInStartLog: true,
    includeRunningInStatusLog: true,
  });

  const cliPackageDistScript = createFixtureDaemonCliScript({
    startLogLine: 'start',
    statusLogLine: 'status',
  });

  await writeStubHappierCliFiles(root, {
    packageJsonContent: '{}\n',
    binHappierScript: cliScript.trimStart(),
    distIndexScript: cliScript.trimStart(),
  });

  const { snapshotDir } = await writeRuntimeSnapshotLayout({
    stackDir,
    snapshotId: 'snap-startable',
    sourceFingerprint: 'src-startable',
    writeCurrentMirror: true,
    currentUpdatedAt: '2026-03-07T12:00:00.000Z',
    createdAt: '2026-03-07T12:00:00.000Z',
    source: {
      repoDir: root,
      serverComponent,
      dbProvider: serverComponent === 'happier-server' ? 'postgresql' : 'sqlite',
      commitSha: 'fixture',
      dirtyHash: 'clean',
      sourceFingerprint: 'src-startable',
      builtAt: '2026-03-07T12:00:00.000Z',
    },
    web: {
      content: '<html><body><div data-testid="runtime-snapshot-ui">RUNTIME SNAPSHOT UI</div></body></html>\n',
      artifactFingerprint: 'web-startable',
    },
    server: {
      content: `#!/usr/bin/env node\n${serverScript.trimStart()}`,
      artifactFingerprint: 'server-startable',
    },
    daemon: {
      content: `#!/usr/bin/env node\n${cliScript.trimStart()}`,
      artifactFingerprint: 'daemon-startable',
      nodeEntrypoint: 'cli/package-dist/index.mjs',
      nodeContent: cliPackageDistScript.trimStart(),
      distClosureFingerprint: daemonDistClosureFingerprint,
    },
  });
  if (serverComponent === 'happier-server' && runtimeMigration !== 'missing') {
    const migrationScript = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(runtimeServerEventLogPath)}, 'migration:' + process.cwd() + ':' + process.env.HAPPIER_DB_PROVIDER + ':' + process.env.DATABASE_URL + '\\n', 'utf8');
`;
    const migrationPath = join(snapshotDir, 'server', 'happier-server-migrate');
    await writeFile(migrationPath, migrationScript, 'utf8');
    await chmod(migrationPath, 0o755);
  }
  const sqliteMigrationsDir = join(snapshotDir, 'server', 'prisma', 'sqlite', 'migrations', '20260101000000_fixture');
  await mkdir(sqliteMigrationsDir, { recursive: true });
  await writeFile(join(sqliteMigrationsDir, 'migration.sql'), '-- fixture migration\n', 'utf8');
  await mkdir(join(stackDir, 'runtime', 'current', 'server', 'prisma', 'sqlite', 'migrations', '20260101000000_fixture'), { recursive: true });
  await writeFile(
    join(stackDir, 'runtime', 'current', 'server', 'prisma', 'sqlite', 'migrations', '20260101000000_fixture', 'migration.sql'),
    '-- fixture migration\n',
    'utf8',
  );

  await writeFile(
    join(stackDir, 'env'),
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_REPO_DIR=${root}`,
      `HAPPIER_STACK_SERVER_COMPONENT=${serverComponent}`,
      `HAPPIER_STACK_SERVER_PORT=${resolvedServerPort}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
      'HAPPIER_STACK_RUNTIME_MODE=require',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_SERVICE_MODE=0',
      'HAPPIER_RUNTIME_SNAPSHOT_MARKER=snap-startable',
      `HAPPIER_RUNTIME_SERVER_ENV_CAPTURE_PATH=${serverEnvCapturePath}`,
      ...(serverComponent === 'happier-server' ? [`HAPPIER_TEST_RUNTIME_SERVER_EVENT_LOG=${runtimeServerEventLogPath}`] : []),
      ...(serverComponent === 'happier-server'
        ? [
            'HAPPIER_STACK_MANAGED_INFRA=0',
            'HAPPIER_DB_PROVIDER=postgresql',
            'DATABASE_URL=postgresql://runtime-fixture.invalid/happier',
          ]
        : []),
      '',
    ].join('\n'),
    'utf8',
  );

  const activeServerId = buildStackStableScopeId({ stackName, cliIdentity: 'default' });
  const credentialPaths = resolveStackCredentialPaths({
    cliHomeDir,
    serverUrl: `http://127.0.0.1:${resolvedServerPort}`,
    env: { HAPPIER_ACTIVE_SERVER_ID: activeServerId },
  });
  await mkdir(dirname(credentialPaths.serverScopedPath), { recursive: true });
  await writeFile(credentialPaths.serverScopedPath, 'dummy\n', 'utf8');
  if (credentialPaths.hostPortServerScopedPath) {
    await mkdir(dirname(credentialPaths.hostPortServerScopedPath), { recursive: true });
    await writeFile(credentialPaths.hostPortServerScopedPath, 'dummy\n', 'utf8');
  }
  if (credentialPaths.urlHashServerScopedPath) {
    await mkdir(dirname(credentialPaths.urlHashServerScopedPath), { recursive: true });
    await writeFile(credentialPaths.urlHashServerScopedPath, 'dummy\n', 'utf8');
  }
  await writeFile(credentialPaths.legacyPath, 'dummy\n', 'utf8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'runtime-fixture-machine' }) + '\n', 'utf8');

  let listenerDiscoveryEnv = {};
  if (listenerDiscoveryMode) {
    const binDir = join(root, 'listener-bin');
    const lsofPath = join(binDir, 'lsof');
    await mkdir(binDir, { recursive: true });
    await writeFile(lsofPath, `#!/bin/sh
group=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-g" ]; then
    shift
    group="$1"
  fi
  shift
done
if [ ! -f "$HAPPIER_TEST_SERVER_PID_CAPTURE_PATH" ]; then
  printf '%s\\n' 'empty' >> "$HAPPIER_TEST_LISTENER_DISCOVERY_LOG_PATH"
  exit 1
fi
if [ "$HAPPIER_TEST_LISTENER_DISCOVERY_MODE" = "delayed-group-proof" ] && [ -n "$group" ]; then
  printf 'group:%s\\n' "$group" >> "$HAPPIER_TEST_LISTENER_DISCOVERY_LOG_PATH"
  sleep 0.3
  sed -n '1p' "$HAPPIER_TEST_SERVER_PID_CAPTURE_PATH"
  exit 0
fi
printf '%s\\n' 'inconclusive' >> "$HAPPIER_TEST_LISTENER_DISCOVERY_LOG_PATH"
sleep 5
`, 'utf8');
    await chmod(lsofPath, 0o755);
    listenerDiscoveryEnv = {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HAPPIER_TEST_LISTENER_DISCOVERY_MODE: listenerDiscoveryMode,
      HAPPIER_TEST_LISTENER_DISCOVERY_LOG_PATH: listenerDiscoveryLogPath,
      HAPPIER_TEST_SERVER_PID_CAPTURE_PATH: serverPidCapturePath,
    };
  }

  return {
    root,
    storageDir,
    stackDir,
    stackName,
    snapshotDir,
    cliHomeDir,
    serverPort: resolvedServerPort,
    serverEnvCapturePath,
    serverPidCapturePath,
    listenerDiscoveryLogPath,
    runtimeServerEventLogPath,
    listenerDiscoveryEnv,
    daemonDistClosureFingerprint,
    baseUrl: `http://127.0.0.1:${resolvedServerPort}`,
  };
}
