import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveStackCredentialPaths } from '../utils/auth/credentials_paths.mjs';
import { buildStackStableScopeId } from '../utils/auth/stable_scope_id.mjs';

function cleanEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

export function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

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

export async function createStartableRuntimeSnapshotFixture(t, {
  stackName = 'runtime-prod',
  serverPort = 4315,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-start-fixture-'));
  const storageDir = join(root, 'storage');
  const stackDir = join(storageDir, stackName);
  const cliHomeDir = join(stackDir, 'cli');
  const snapshotDir = join(stackDir, 'runtime', 'builds', 'snap-startable');
  const runtimeDir = join(stackDir, 'runtime');
  const currentDir = join(runtimeDir, 'current');
  const serverDir = join(snapshotDir, 'server');
  const cliDir = join(snapshotDir, 'cli');
  const uiDir = join(snapshotDir, 'ui');
  const currentServerDir = join(currentDir, 'server');
  const currentCliDir = join(currentDir, 'cli');
  const currentUiDir = join(currentDir, 'ui');
  const serverEnvCapturePath = join(stackDir, 'server.runtime-env.json');
  const sqliteMigrationsDir = join(serverDir, 'prisma', 'sqlite', 'migrations', '20260101000000_fixture');

  const preserveFixture = (process.env.HAPPIER_TEST_PRESERVE_RUNTIME_FIXTURE ?? '').toString().trim() === '1';
  t.after(async () => {
    if (preserveFixture) return;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(serverDir, { recursive: true });
  await mkdir(cliDir, { recursive: true });
  await mkdir(join(cliDir, 'package-dist'), { recursive: true });
  await mkdir(uiDir, { recursive: true });
  await mkdir(currentServerDir, { recursive: true });
  await mkdir(currentCliDir, { recursive: true });
  await mkdir(join(currentCliDir, 'package-dist'), { recursive: true });
  await mkdir(currentUiDir, { recursive: true });
  await mkdir(cliHomeDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(sqliteMigrationsDir, { recursive: true });
  await writeFile(join(sqliteMigrationsDir, 'migration.sql'), '-- fixture migration\n', 'utf8');

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

  const cliScript = `
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
  append('start:' + String(process.env.HAPPIER_SERVER_URL || ''));
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
  append('status:' + String(running));
  console.log(running ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}
process.exit(0);
`;

  const cliPackageDistScript = `
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
  append('start');
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
  append('status');
  console.log(running ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}
process.exit(0);
`;

  await writeFile(join(serverDir, 'happier-server'), `#!/usr/bin/env node\n${serverScript.trimStart()}`, 'utf8');
  await writeFile(join(cliDir, 'happier'), `#!/usr/bin/env node\n${cliScript.trimStart()}`, 'utf8');
  await writeFile(join(cliDir, 'package-dist', 'index.mjs'), cliPackageDistScript.trimStart(), 'utf8');
  await writeFile(join(currentServerDir, 'happier-server'), `#!/usr/bin/env node\n${serverScript.trimStart()}`, 'utf8');
  await writeFile(join(currentCliDir, 'happier'), `#!/usr/bin/env node\n${cliScript.trimStart()}`, 'utf8');
  await writeFile(join(currentCliDir, 'package-dist', 'index.mjs'), cliPackageDistScript.trimStart(), 'utf8');
  await chmod(join(serverDir, 'happier-server'), 0o755);
  await chmod(join(cliDir, 'happier'), 0o755);
  await chmod(join(currentServerDir, 'happier-server'), 0o755);
  await chmod(join(currentCliDir, 'happier'), 0o755);
  await writeFile(join(uiDir, 'index.html'), '<html><body><div data-testid="runtime-snapshot-ui">RUNTIME SNAPSHOT UI</div></body></html>\n', 'utf8');
  await writeFile(join(currentUiDir, 'index.html'), '<html><body><div data-testid="runtime-snapshot-ui">RUNTIME SNAPSHOT UI</div></body></html>\n', 'utf8');

  await writeFile(
    join(snapshotDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-startable',
      sourceFingerprint: 'src-startable',
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
      components: {
        web: { artifactFingerprint: 'web-startable', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'server-startable', entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: 'daemon-startable', entrypoint: 'cli/happier' },
      },
    }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    join(currentDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-startable',
      sourceFingerprint: 'src-startable',
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
      components: {
        web: { artifactFingerprint: 'web-startable', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'server-startable', entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: 'daemon-startable', entrypoint: 'cli/happier' },
      },
    }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    join(runtimeDir, 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-startable',
      snapshotPath: snapshotDir,
      sourceFingerprint: 'src-startable',
      updatedAt: '2026-03-07T12:00:00.000Z',
    }, null, 2) + '\n',
    'utf8',
  );

  await writeFile(
    join(stackDir, 'env'),
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_REPO_DIR=${root}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
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
    serverUrl: `http://127.0.0.1:${serverPort}`,
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
    serverPort,
    serverEnvCapturePath,
    baseUrl: `http://127.0.0.1:${serverPort}`,
  };
}
