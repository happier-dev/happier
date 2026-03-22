import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveStackCredentialPaths } from '../utils/auth/credentials_paths.mjs';
import { buildStackStableScopeId } from '../utils/auth/stable_scope_id.mjs';
import { pickNextFreeTcpPort } from '../utils/net/ports.mjs';
import { runNodeCapture } from './core/run_node_capture.mjs';
import { writeRuntimeSnapshotLayout } from './core/runtime_snapshot_layout.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export const runNode = runNodeCapture;

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
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const home = String(process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR || '').trim();
if (!home) {
  console.error('missing HAPPIER_HOME_DIR');
  process.exit(2);
}
const statePath = join(home, 'daemon.state.json');
const activeServerId = String(process.env.HAPPIER_ACTIVE_SERVER_ID || '').trim();
const serverScopedStatePath = activeServerId ? join(home, 'servers', activeServerId, 'daemon.state.json') : '';
const logPath = join(home, 'runtime-daemon.log');
const append = (line) => {
  writeFileSync(logPath, line + '\\n', { flag: 'a' });
};
const writeState = (payload) => {
  writeFileSync(statePath, payload, 'utf8');
  if (serverScopedStatePath) {
    mkdirSync(dirname(serverScopedStatePath), { recursive: true });
    writeFileSync(serverScopedStatePath, payload, 'utf8');
  }
};
const removeState = () => {
  try { rmSync(statePath); } catch {}
  if (serverScopedStatePath) {
    try { rmSync(serverScopedStatePath); } catch {}
  }
};
if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'start') {
  ${includeServerUrlInStartLog
    ? "append('start:' + String(process.env.HAPPIER_SERVER_URL || ''));"
    : `append(${JSON.stringify(startLogLine)});`}
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeState(JSON.stringify({ pid: child.pid, httpPort: 0, startedAt: new Date().toISOString() }) + '\\n');
  process.exit(0);
}
if (sub === 'stop') {
  append('stop');
  if (existsSync(statePath)) {
    try {
      const pid = Number(JSON.parse(readFileSync(statePath, 'utf8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
  }
  removeState();
  process.exit(0);
}
if (sub === 'status') {
  const running = existsSync(statePath);
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

  await mkdir(cliHomeDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const serverScript = `
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.PORT || process.env.HAPPIER_SERVER_PORT || 0);
if (!Number.isFinite(port) || port <= 0) {
  console.error('missing HAPPIER_SERVER_PORT');
  process.exit(2);
}
const uiDir = String(process.env.HAPPIER_SERVER_UI_DIR || '').trim();
const marker = String(process.env.HAPPIER_RUNTIME_SNAPSHOT_MARKER || 'runtime-snapshot');
const envCapturePath = String(process.env.HAPPIER_RUNTIME_SERVER_ENV_CAPTURE_PATH || '').trim();
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
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', marker }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = readFileSync(join(uiDir, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log('runtime-server-ready:' + port);
});

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

  const { snapshotDir } = await writeRuntimeSnapshotLayout({
    stackDir,
    snapshotId: 'snap-startable',
    sourceFingerprint: 'src-startable',
    writeCurrentMirror: true,
    currentUpdatedAt: '2026-03-07T12:00:00.000Z',
    createdAt: '2026-03-07T12:00:00.000Z',
    source: {
      repoDir: root,
      serverComponent: 'happier-server-light',
      dbProvider: 'sqlite',
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
    },
  });
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
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_SERVER_PORT=${resolvedServerPort}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
      'HAPPIER_STACK_RUNTIME_MODE=require',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_SERVICE_MODE=0',
      'HAPPIER_RUNTIME_SNAPSHOT_MARKER=snap-startable',
      `HAPPIER_RUNTIME_SERVER_ENV_CAPTURE_PATH=${serverEnvCapturePath}`,
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

  return {
    root,
    storageDir,
    stackDir,
    stackName,
    snapshotDir,
    cliHomeDir,
    serverPort: resolvedServerPort,
    serverEnvCapturePath,
    baseUrl: `http://127.0.0.1:${resolvedServerPort}`,
  };
}
