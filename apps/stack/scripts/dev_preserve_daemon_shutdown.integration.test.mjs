import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';
import {
  isPidAlive,
  readStackRuntimeStateFile,
  recordStackRuntimeStopRequest,
} from './utils/stack/runtime_state.mjs';
import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

function stackRootDirFromMeta(metaUrl) {
  return dirname(dirname(fileURLToPath(metaUrl)));
}

async function waitFor(check, { timeoutMs = 15_000, intervalMs = 25, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function startAuthServer(t) {
  const server = createServer((req, res) => {
    if (req.url === '/v1/account/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function createDaemonCliSource() {
  const daemonSource = String.raw`
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const statePath = process.env.HAPPIER_TEST_DAEMON_STATE_PATH;
const token = 'dev-preserve-daemon-control';
const server = createServer((req, res) => {
  const authenticated = req.headers['x-happier-daemon-token'] === token;
  if (req.method === 'POST' && req.url === '/ping' && authenticated) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, distClosureFingerprint: '0000000000000000' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/stop' && authenticated) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    res.once('finish', () => server.close());
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    pid: process.pid,
    httpPort: server.address().port,
    controlToken: token,
    startedAt: Date.now(),
    startedWithCliVersion: 'test',
  }) + '\n');
});
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;
  return `
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const [command, subcommand] = process.argv.slice(2);
const statePath = process.env.HAPPIER_TEST_DAEMON_STATE_PATH;
const stopMarkerPath = process.env.HAPPIER_TEST_DAEMON_STOP_MARKER_PATH;

if (command !== 'daemon') process.exit(0);
if (subcommand === 'status') process.exit(0);
if (subcommand === 'stop') {
  appendFileSync(stopMarkerPath, 'stop\\n');
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    process.kill(Number(state.pid), 'SIGTERM');
  } catch {}
  process.exit(0);
}
if (subcommand === 'start') {
  const source = ${JSON.stringify(daemonSource)};
  const child = spawn(process.execPath, ['-e', source], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  process.exit(0);
}
process.exit(1);
`;
}

test('dev lifecycle-owner shutdown consumes a fresh preserveDaemon request', { timeout: 30_000 }, async (t) => {
  const stackRootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-preserve-daemon-' });
  const repoDir = join(fixture.root, 'repo');
  const stackName = 'preserve-daemon';
  const runtimeStatePath = join(fixture.root, 'stack.runtime.json');
  const cliHomeDir = join(fixture.root, 'cli-home');
  const stopMarkerPath = join(fixture.root, 'daemon-stop-called');
  const serverUrl = await startAuthServer(t);

  await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'server'), { recursive: true });
  await writeStubHappierCliFiles(repoDir, {
    packageJsonContent: JSON.stringify({ name: '@fixture/cli', version: '0.0.0' }),
    distIndexScript: createDaemonCliSource(),
    binHappierScript: "import '../dist/index.mjs';\n",
  });
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'test-token\n', 'utf8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf8');

  const baseEnv = {
    ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_CLI_BUILD: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '1000',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '5000',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    HAPPIER_STACK_NO_BROWSER: '1',
    HAPPIER_TEST_DAEMON_STOP_MARKER_PATH: stopMarkerPath,
  };
  const daemonEnv = applyStackActiveServerScopeEnv({ env: baseEnv, stackName, cliIdentity: 'default' });
  const { statePath: daemonStatePath } = resolvePreferredStackDaemonStatePaths({
    cliHomeDir,
    serverUrl,
    env: daemonEnv,
  });
  baseEnv.HAPPIER_TEST_DAEMON_STATE_PATH = daemonStatePath;

  const owner = spawn(process.execPath, [
    join(stackRootDir, 'scripts', 'dev.mjs'),
    '--no-server',
    '--no-ui',
    '--no-watch',
    `--server-url=${serverUrl}`,
  ], {
    cwd: repoDir,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  owner.stdout.on('data', (chunk) => { stdout += String(chunk); });
  owner.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const ownerExit = new Promise((resolve) => owner.once('exit', (code, signal) => resolve({ code, signal })));
  let daemonPid = null;
  t.after(async () => {
    if (owner.exitCode == null && owner.signalCode == null) owner.kill('SIGKILL');
    if (Number(daemonPid) > 1 && isPidAlive(daemonPid)) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
  });

  const runtime = await waitFor(async () => {
    if (owner.exitCode != null || owner.signalCode != null) {
      throw new Error(`dev owner exited before daemon startup\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const state = await readStackRuntimeStateFile(runtimeStatePath).catch(() => null);
    const pid = Number(state?.processes?.daemonPid);
    return Number.isFinite(pid) && pid > 1 && isPidAlive(pid) ? state : null;
  }, { label: 'dev owner to publish a live daemon pid' });
  daemonPid = Number(runtime.processes.daemonPid);
  // Runtime daemon publication happens just before the owner finishes installing
  // its reload composition and signal handlers. Let that bounded synchronous tail settle.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const stopMarkerBeforeShutdown = await readFile(stopMarkerPath, 'utf8').catch(() => '');

  await recordStackRuntimeStopRequest(runtimeStatePath, {
    signal: 'SIGTERM',
    requestedBy: 'integration test',
    reason: 'restart while preserving daemon',
    preserveDaemon: true,
  });
  owner.kill('SIGTERM');
  const exit = await waitFor(async () => {
    const result = await Promise.race([
      ownerExit,
      new Promise((resolve) => setTimeout(() => resolve(null), 25)),
    ]);
    return result;
  }, { label: 'dev owner shutdown' });

  assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.equal(isPidAlive(daemonPid), true, 'fresh preserveDaemon request must keep the daemon alive');
  assert.equal(await readFile(stopMarkerPath, 'utf8').catch(() => ''), stopMarkerBeforeShutdown);
  const finalized = await readStackRuntimeStateFile(runtimeStatePath);
  assert.ok(finalized?.processes?.daemonPids?.includes(daemonPid));
});

async function startStackOwnedRunServer(t, { stackName, envPath }) {
  const child = spawn(process.execPath, ['-e', String.raw`
    const { createServer } = require('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
        return;
      }
      if (req.url === '/v1/account/profile') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\n'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `], {
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'server',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for run server')), 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const value = Number(text.trim());
      if (Number.isFinite(value) && value > 0) {
        clearTimeout(timer);
        resolve(value);
      }
    });
    child.once('error', reject);
  });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
  return { child, port };
}

test('run lifecycle owner admits an early stop once and preserves the daemon', { timeout: 40_000 }, async (t) => {
  const stackRootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createTempFixture(t, { prefix: 'hstack-run-preserve-daemon-' });
  const repoDir = join(fixture.root, 'repo');
  const stackName = 'run-preserve-daemon';
  const runtimeStatePath = join(fixture.root, 'stack.runtime.json');
  const envPath = join(fixture.root, 'stack.env');
  const cliHomeDir = join(fixture.root, 'cli-home');
  const stopMarkerPath = join(fixture.root, 'daemon-stop-called');
  const server = await startStackOwnedRunServer(t, { stackName, envPath });

  await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoDir, 'apps', 'server'), { recursive: true });
  await writeFile(envPath, `HAPPIER_STACK_SERVER_PORT=${server.port}\n`, 'utf8');
  await writeFile(join(repoDir, 'apps', 'server', 'package.json'), JSON.stringify({
    name: '@fixture/server',
    private: true,
    scripts: { start: 'node server.mjs' },
  }) + '\n', 'utf8');
  await writeStubHappierCliFiles(repoDir, {
    packageJsonContent: JSON.stringify({ name: '@fixture/cli', version: '0.0.0' }),
    distIndexScript: createDaemonCliSource(),
    binHappierScript: "import '../dist/index.mjs';\n",
  });
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'test-token\n', 'utf8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf8');

  const baseEnv = {
    ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_SERVER_PORT: String(server.port),
    HAPPIER_STACK_CLI_BUILD: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '1000',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '5000',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    HAPPIER_STACK_SERVE_UI: '0',
    HAPPIER_STACK_NO_BROWSER: '1',
    HAPPIER_TEST_DAEMON_STOP_MARKER_PATH: stopMarkerPath,
  };
  const daemonEnv = applyStackActiveServerScopeEnv({ env: baseEnv, stackName, cliIdentity: 'default' });
  const { statePath: daemonStatePath } = resolvePreferredStackDaemonStatePaths({
    cliHomeDir,
    serverUrl: `http://127.0.0.1:${server.port}`,
    env: daemonEnv,
  });
  baseEnv.HAPPIER_TEST_DAEMON_STATE_PATH = daemonStatePath;

  const owner = spawn(process.execPath, [join(stackRootDir, 'scripts', 'run.mjs'), '--source', '--no-ui'], {
    cwd: repoDir,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  owner.stdout.on('data', (chunk) => { stdout += String(chunk); });
  owner.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const ownerExit = new Promise((resolve) => owner.once('exit', (code, signal) => resolve({ code, signal })));
  let daemonPid = null;
  t.after(() => {
    if (owner.exitCode == null && owner.signalCode == null) owner.kill('SIGKILL');
    if (Number(daemonPid) > 1 && isPidAlive(daemonPid)) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
  });

  const runtime = await waitFor(async () => {
    if (owner.exitCode != null || owner.signalCode != null) {
      throw new Error(`run owner exited before daemon publication\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const state = await readStackRuntimeStateFile(runtimeStatePath).catch(() => null);
    const pid = Number(state?.processes?.daemonPid);
    return Number.isFinite(pid) && pid > 1 && isPidAlive(pid) ? state : null;
  }, { label: 'run owner to publish a live daemon pid' });
  daemonPid = Number(runtime.processes.daemonPid);
  const stopMarkerBeforeShutdown = await readFile(stopMarkerPath, 'utf8').catch(() => '');

  const stopPromise = stopStackWithEnv({
    rootDir: stackRootDir,
    stackName,
    baseDir: fixture.root,
    env: baseEnv,
    json: true,
    noDocker: true,
    preserveDaemon: true,
    expectedOwnerPid: owner.pid,
    expectedOwnerStartedAt: runtime.startedAt,
  });
  await waitFor(async () => {
    const state = await readStackRuntimeStateFile(runtimeStatePath).catch(() => null);
    return state?.stopRequest?.preserveDaemon === true;
  }, { label: 'run stop boundary to publish preserveDaemon' });
  await waitFor(
    () => stdout.includes('[local] shutting down'),
    { label: 'run owner to begin canonical shutdown' },
  );
  owner.kill('SIGTERM');
  const [stopResult, exit] = await Promise.all([stopPromise, ownerExit]);

  assert.equal(exit.code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.equal((stdout.match(/\[local\] shutting down/g) ?? []).length, 1, 'two signals must dispatch one shutdown');
  assert.equal(stopResult.stopAuthorization?.authorized, true);
  assert.equal(stopResult.preserveDaemon, true);
  assert.equal(isPidAlive(daemonPid), true, 'preserveDaemon must retain the published daemon');
  assert.equal(
    await readFile(stopMarkerPath, 'utf8').catch(() => ''),
    stopMarkerBeforeShutdown,
    `stdout:\n${stdout}\nstderr:\n${stderr}\nstopResult:\n${JSON.stringify(stopResult, null, 2)}`,
  );
  const finalized = await readStackRuntimeStateFile(runtimeStatePath);
  assert.equal(finalized?.ownerPid, null);
  assert.equal(finalized?.stopRequest, null);
  assert.ok(finalized?.processes?.daemonPids?.includes(daemonPid));
});
