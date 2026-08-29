import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { mkdtemp, chmod, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkDaemonState,
  DEFAULT_STACK_DAEMON_START_VERIFY_TIMEOUT_MS,
  matchDaemonEnvLine,
  resolveAttendedStartupTimeoutMs,
  resolveStackDaemonStartVerifyTimeoutMs,
  shouldContinueAttendedDaemonStartVerification,
  startLocalDaemonWithAuth,
} from './daemon.mjs';
import { killDetachedProcessGroup } from './testkit/core/spawn_daemon_like_process.mjs';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import {
  writeStubCliDistBuildManifest,
  writeStubHappierCliFiles,
} from './testkit/core/stub_happier_cli_files.mjs';
import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';
import { inspectDependencyRefresh } from './utils/proc/dependency_refresh.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);
const DAEMON_TEST_PROCESS_HELPER_PATH = join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs');
const PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS = '15000';

function buildDelayedDaemonStartCliScript({
  cliHomeDir,
  startDelayMs,
  startExitCode = 0,
  childPidPath = '',
}) {
  const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
  return `
import { writeFileSync } from 'node:fs';
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  const child = spawnDaemonLikeProcess({
    cliHomeDir: home,
    statePaths: [${JSON.stringify(statePath)}],
    internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
    publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
    startDelayMs: ${JSON.stringify(startDelayMs)},
  });
  ${childPidPath ? `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), 'utf-8');` : ''}
  process.exit(${JSON.stringify(startExitCode)});
}

process.exit(0);
`.trimStart();
}

function buildBudgetBoundDaemonStartCliScript({
  cliHomeDir,
  startDelayMs,
  childPidPath,
  outcomePath,
}) {
  const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
  return `
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const args = process.argv.slice(2);
if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);
if (sub !== 'start') process.exit(0);

const child = spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  statePaths: [${JSON.stringify(statePath)}],
  internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
  publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
  startDelayMs: ${JSON.stringify(startDelayMs)},
});
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), 'utf-8');

const waitMs = Number(process.env.HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS || '0');
if (waitMs < ${JSON.stringify(startDelayMs)}) {
  await delay(Math.max(waitMs, 1));
  writeFileSync(${JSON.stringify(outcomePath)}, JSON.stringify({ outcome: 'failed', waitMs }), 'utf-8');
  process.exit(1);
}

await delay(${JSON.stringify(startDelayMs)});
writeFileSync(${JSON.stringify(outcomePath)}, JSON.stringify({ outcome: 'started', waitMs }), 'utf-8');
`.trimStart();
}

function buildSynchronousDaemonStartCliScript({ cliHomeDir, startDelayMs }) {
  const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
  return `
import { startDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  await startDaemonLikeProcess({
    statePaths: [${JSON.stringify(statePath)}],
    startDelayMs: ${JSON.stringify(startDelayMs)},
  });
} else {
  process.exit(0);
}
`.trimStart();
}

test('stack daemon start verification default matches the daemon restart wait budget', () => {
  assert.equal(resolveStackDaemonStartVerifyTimeoutMs({}), 120_000);
  assert.equal(resolveStackDaemonStartVerifyTimeoutMs({ HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1234' }), 1234);
});

test('attended daemon verification only extends a checkpoint for a live daemon process', () => {
  assert.equal(shouldContinueAttendedDaemonStartVerification({
    isTui: true,
    state: { status: 'starting', pid: 123 },
  }), true);
  assert.equal(shouldContinueAttendedDaemonStartVerification({
    isTui: false,
    state: { status: 'starting', pid: 123 },
  }), false);
  assert.equal(shouldContinueAttendedDaemonStartVerification({
    isTui: true,
    state: { status: 'not_running' },
  }), false);
});

test('attended startup removes terminal lock and credential deadlines without changing unattended budgets', () => {
  assert.equal(resolveAttendedStartupTimeoutMs({ isTui: true, timeoutMs: 1234 }), Infinity);
  assert.equal(resolveAttendedStartupTimeoutMs({ isTui: false, timeoutMs: 1234 }), 1234);
});

test('matchDaemonEnvLine identifies which daemon env binding differs', () => {
  const line = [
    'node',
    'HAPPIER_HOME_DIR=/tmp/happier-stack/cli',
    'HAPPIER_SERVER_URL=http://127.0.0.1:52753',
    'HAPPIER_WEBAPP_URL=http://stale.localhost:52753',
  ].join(' ');

  assert.deepEqual(matchDaemonEnvLine({
    line,
    cliHomeDir: '/tmp/happier-stack/cli',
    internalServerUrl: 'http://127.0.0.1:52753',
    publicServerUrl: 'http://happier-stack.localhost:52753',
  }), {
    matches: false,
    reason: 'webapp',
    key: 'HAPPIER_WEBAPP_URL',
    expected: 'http://happier-stack.localhost:52753',
  });
});

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      env: createFixtureStackEnv(cwd, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr }));
  });
}

function runNodeWithTimeout(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawnDetachedTestProcess(process.execPath, args, {
      cwd,
      env: createFixtureStackEnv(cwd, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // ignore
      }
      finish({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true });
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', fail);
    proc.on('exit', (code, signal) =>
      finish({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr, timedOut: false })
    );
  });
}

function createFixtureStackEnv(repoDir, baseEnv = process.env) {
  return {
    ...baseEnv,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_TUI: '0',
  };
}

async function writeStubHappyCli({ cliDir }) {
  const distScript = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);
const logsDir = join(home, 'logs');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, \`\${Date.now()}-pid-\${process.pid}-daemon.log\`);
  writeFileSync(
    logPath,
    '[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1 {"message":"Request failed with status code 401","status":401}\\n',
    'utf-8'
  );
  // Simulate false-positive daemon start command: exits 0 but daemon is not actually running.
  process.exit(0);
}

process.exit(0);
`;
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: distScript.trimStart(),
    // If daemon.mjs accidentally invokes bin/happier.mjs, fail loudly.
    binHappierScript: 'process.exit(42);\n',
  });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  const dependencyRefresh = await inspectDependencyRefresh({ installDir: cliDir, componentDir: cliDir });
  await mkdir(dirname(dependencyRefresh.markerPath), { recursive: true });
  await writeFile(
    dependencyRefresh.markerPath,
    `${JSON.stringify({ version: 3, installDir: cliDir, inputs: dependencyRefresh.inputSnapshot, superseded: false })}\n`,
    'utf-8',
  );
  return join(cliBinDir, 'happier.mjs');
}

function buildProfileCaptureDaemonCliScript({ cliHomeDir, capturePath }) {
  const activeServerId = 'stack_dev__id_default';
  const statePath = join(cliHomeDir, 'servers', activeServerId, 'daemon.state.json');
  return `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] === 'server' && args[1] === 'set') {
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? String(args[index + 1] || '') : '';
  };
  const settingsPath = join(home, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const serverId = value('--server-id');
  const current = settings.servers?.[serverId] ?? {};
  settings.activeServerId = serverId;
  settings.servers = {
    ...(settings.servers ?? {}),
    [serverId]: {
      ...current,
      id: serverId,
      serverUrl: value('--server-url'),
      localServerUrl: value('--local-server-url'),
      webappUrl: value('--webapp-url'),
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
  process.exit(0);
}

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop' || sub === 'status') process.exit(0);
if (sub !== 'start') process.exit(0);

const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf-8'));
const activeServerId = String(settings.activeServerId || '');
writeFileSync(
  ${JSON.stringify(capturePath)},
  JSON.stringify({ activeServerId, profile: settings.servers?.[activeServerId] ?? null }) + '\\n',
  'utf-8',
);
spawnDaemonLikeProcess({
  cliHomeDir: home,
  internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
  publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
  statePaths: [${JSON.stringify(statePath)}],
});
process.exit(0);
`.trimStart();
}

async function overwriteStubCliDist(cliDir, source) {
  await writeFile(join(cliDir, 'dist', 'index.mjs'), source, 'utf-8');
  writeStubCliDistBuildManifest(cliDir);
}

function createTestJwt({ sub, jti }) {
    const headerJson = JSON.stringify({ alg: 'none', typ: 'JWT' });
    const payloadJson = JSON.stringify({ sub, ...(jti ? { jti } : {}) });
    const toB64Url = (value) =>
        Buffer.from(value, 'utf8')
            .toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    return `${toB64Url(headerJson)}.${toB64Url(payloadJson)}.`;
}

async function withAuthServer({ goodToken }, fn) {
    const server = http.createServer((req, res) => {
        if (!req.url || !req.method) {
            res.statusCode = 400;
            res.end();
            return;
        }
        if (req.method !== 'GET' || req.url !== '/v1/account/profile') {
            res.statusCode = 404;
            res.end();
            return;
        }
        const auth = String(req.headers.authorization ?? '').trim();
        if (auth === `Bearer ${goodToken}`) {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    assert.ok(port, 'auth test server should expose a port');
    const serverUrl = `http://127.0.0.1:${port}`;
    try {
        return await fn({ serverUrl });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function writeAccessKeyFile(path, token) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        JSON.stringify(
            {
                encryption: { publicKey: 'AA==', machineKey: 'AA==' },
                token,
            },
            null,
            2,
        ),
        'utf-8',
    );
}

test('startLocalDaemonWithAuth treats daemon start exit=0 as failure when daemon never becomes running', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-start-verify-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    };

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliCommand: process.execPath,
        cliCommandArgs: [join(cliDir, 'dist', 'index.mjs')],
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env,
        stackName: 'dev',
      }),
      /Failed to auto re-seed daemon credentials|Failed to start daemon/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth reconciles a stale active stack profile before spawning the daemon', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-profile-reconcile-'));
  let daemonPid = null;
  try {
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const cliBin = join(tmp, 'bin', 'happier');
    const cliCommandScript = join(tmp, 'profile-capture-daemon.mjs');
    const capturePath = join(tmp, 'profile-at-daemon-start.json');
    const activeServerId = 'stack_dev__id_default';
    const internalServerUrl = 'http://127.0.0.1:4311';
    const publicServerUrl = 'http://localhost:4311';
    const credentialContents = 'credential-must-remain-unchanged\\n';

    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      buildProfileCaptureDaemonCliScript({ cliHomeDir, capturePath }),
      'utf-8',
    );
    await writeFile(
      join(cliHomeDir, 'settings.json'),
      JSON.stringify({
        schemaVersion: 6,
        activeServerId,
        servers: {
          [activeServerId]: {
            id: activeServerId,
            name: 'Controlled stack profile',
            serverUrl: 'http://127.0.0.1:3012',
            localServerUrl: 'http://127.0.0.1:3012',
            webappUrl: 'http://localhost:3012',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
            preservedProfileField: 'keep-me',
          },
        },
      }, null, 2) + '\n',
      'utf-8',
    );

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STORAGE_DIR: join(tmp, 'storage'),
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '2000',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    };
    const credentialPaths = resolveStackCredentialPaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: { ...env, HAPPIER_ACTIVE_SERVER_ID: activeServerId },
    });
    await mkdir(dirname(credentialPaths.serverScopedPath), { recursive: true });
    await writeFile(credentialPaths.serverScopedPath, credentialContents, 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => false,
      forceRestart: true,
      env,
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const daemonState = JSON.parse(
      await readFile(join(cliHomeDir, 'servers', activeServerId, 'daemon.state.json'), 'utf-8'),
    );
    daemonPid = Number(daemonState?.pid);

    const profileAtDaemonStart = JSON.parse(await readFile(capturePath, 'utf-8'));
    assert.equal(profileAtDaemonStart.activeServerId, activeServerId);
    assert.equal(profileAtDaemonStart.profile?.serverUrl, internalServerUrl);
    assert.equal(profileAtDaemonStart.profile?.localServerUrl, internalServerUrl);
    assert.equal(profileAtDaemonStart.profile?.webappUrl, publicServerUrl);
    assert.equal(profileAtDaemonStart.profile?.preservedProfileField, 'keep-me');

    const persistedSettings = JSON.parse(await readFile(join(cliHomeDir, 'settings.json'), 'utf-8'));
    assert.equal(persistedSettings.activeServerId, activeServerId);
    assert.equal(persistedSettings.servers[activeServerId].serverUrl, internalServerUrl);
    assert.equal(persistedSettings.servers[activeServerId].localServerUrl, internalServerUrl);
    assert.equal(persistedSettings.servers[activeServerId].webappUrl, publicServerUrl);
    assert.equal(persistedSettings.servers[activeServerId].preservedProfileField, 'keep-me');
    assert.equal(await readFile(credentialPaths.serverScopedPath, 'utf-8'), credentialContents);
  } finally {
    if (Number.isFinite(daemonPid) && daemonPid > 1) {
      killDetachedProcessGroup(daemonPid, 'SIGKILL');
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not present a daemon log from before the failed start attempt', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-current-log-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const originalConsoleError = console.error;
  const errorOutput = [];

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(join(cliHomeDir, 'logs'), { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'logs', '1-pid-1-daemon.log'), 'historical daemon failure\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      `
const [scope, action] = process.argv.slice(2);
if (scope !== 'daemon') process.exit(0);
if (action === 'stop') process.exit(0);
if (action === 'status') process.exit(1);
if (action === 'start') process.exit(0);
process.exit(0);
      `.trimStart(),
      'utf-8',
    );

    console.error = (...args) => {
      errorOutput.push(args.map((arg) => String(arg)).join(' '));
    };

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliCommand: process.execPath,
        cliCommandArgs: [cliCommandScript],
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...createFixtureStackEnv(tmp),
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
        cliIdentity: 'default',
      }),
      /Failed to start daemon/,
    );

    const diagnostics = errorOutput.join('\n');
    assert.doesNotMatch(diagnostics, /historical daemon failure/);
    assert.match(diagnostics, /no daemon log found/);
  } finally {
    console.error = originalConsoleError;
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth cancels and joins timed-out or shutdown daemon start wrappers before retry', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-start-timeout-cancel-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const wrapperPidPath = join(tmp, 'wrapper.pid');
  let wrapperPid = null;

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      `
import { writeFileSync } from 'node:fs';

const [scope, action] = process.argv.slice(2);
if (scope !== 'daemon') process.exit(0);
if (action === 'stop') process.exit(0);
if (action === 'status') process.exit(1);
if (action !== 'start') process.exit(0);

writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid), 'utf-8');
setInterval(() => {}, 1_000);
      `.trimStart(),
      'utf-8',
    );

    const startArgs = {
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...createFixtureStackEnv(tmp),
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS: '10',
        HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '150',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    };

    await assert.rejects(
      startLocalDaemonWithAuth(startArgs),
      /Failed to start daemon/,
    );

    wrapperPid = Number(await readFile(wrapperPidPath, 'utf-8'));
    assert.ok(Number.isFinite(wrapperPid) && wrapperPid > 1);
    assert.throws(
      () => process.kill(wrapperPid, 0),
      `timed-out daemon start wrapper ${wrapperPid} must exit before another reconciliation can start`,
    );

    await writeFile(wrapperPidPath, '', 'utf-8');
    const shutdownStartedAt = Date.now();
    await assert.rejects(
      startLocalDaemonWithAuth({
        ...startArgs,
        isShuttingDown: () => true,
        env: {
          ...startArgs.env,
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '30000',
        },
      }),
      /Failed to start daemon/,
    );
    assert.ok(Date.now() - shutdownStartedAt < 5_000, 'shutdown must cancel the active start attempt without waiting for its health deadline');
  } finally {
    if (Number.isFinite(wrapperPid) && wrapperPid > 1) {
      try {
        killDetachedProcessGroup(wrapperPid, 'SIGKILL');
      } catch {
        // already stopped by the owner under test
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth fails fast when stack-scoped auth is stale and only a different-account fallback is valid', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-auth-stale-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: 'stack_dev__id_default',
    };

    const staleToken = createTestJwt({ sub: 'account-a', jti: 'stale' });
    const validOtherAccountToken = createTestJwt({ sub: 'account-b', jti: 'valid' });

    await withAuthServer({ goodToken: validOtherAccountToken }, async ({ serverUrl }) => {
      const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
      await writeAccessKeyFile(resolved.serverScopedPath, staleToken);
      await writeAccessKeyFile(resolved.urlHashServerScopedPath, validOtherAccountToken);

      await assert.rejects(
        startLocalDaemonWithAuth({
          cliBin,
          cliEntrypoint: join(cliDir, 'dist', 'index.mjs'),
          cliHomeDir,
          internalServerUrl: serverUrl,
          publicServerUrl: serverUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName: 'dev',
        }),
        /Failed to auto re-seed daemon credentials|credentials were rejected by the server|auth login/i,
      );

      await assert.rejects(stat(join(cliHomeDir, 'logs')), { code: 'ENOENT' });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not backfill legacy access.key from main when the stack already has a server-scoped credential', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-no-legacy-backfill-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const storageDir = join(tmp, 'storage');
    const stackName = 'dev';
    const cliHomeDir = join(storageDir, stackName, 'cli');
    const mainCliHomeDir = join(storageDir, 'main', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(mainCliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '1',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: `stack_${stackName}__id_default`,
    };

    const currentToken = createTestJwt({ sub: 'current-account', jti: 'current' });
    const mainToken = createTestJwt({ sub: 'main-account', jti: 'main' });

    await withAuthServer({ goodToken: currentToken }, async ({ serverUrl }) => {
      const targetPaths = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
      const mainPaths = resolveStackCredentialPaths({
        cliHomeDir: mainCliHomeDir,
        serverUrl,
        env: { ...env, HAPPIER_STACK_STACK: 'main', HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default' },
      });

      await writeAccessKeyFile(targetPaths.serverScopedPath, currentToken);
      await writeAccessKeyFile(mainPaths.serverScopedPath, mainToken);
      await writeAccessKeyFile(join(mainCliHomeDir, 'access.key'), mainToken);

      await assert.rejects(
        startLocalDaemonWithAuth({
          cliBin,
          cliEntrypoint: join(cliDir, 'dist', 'index.mjs'),
          cliHomeDir,
          internalServerUrl: serverUrl,
          publicServerUrl: serverUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName,
        }),
        /Failed to auto re-seed daemon credentials|Failed to start daemon|credentials were rejected by the server/i,
      );

      await assert.rejects(stat(join(cliHomeDir, 'access.key')), { code: 'ENOENT' });
      const activeCredential = JSON.parse(await readFile(targetPaths.serverScopedPath, 'utf-8'));
      assert.equal(activeCredential.token, currentToken);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth seeds the current server credential when the stack only has an unrelated server credential', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-unrelated-credential-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const storageDir = join(tmp, 'storage');
    const stackName = 'dev';
    const cliHomeDir = join(storageDir, stackName, 'cli');
    const mainCliHomeDir = join(storageDir, 'main', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(mainCliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = {
      ...createFixtureStackEnv(tmp),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '1',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: `stack_${stackName}__id_default`,
    };

    const currentToken = createTestJwt({ sub: 'current-account', jti: 'current' });
    const unrelatedToken = createTestJwt({ sub: 'other-account', jti: 'unrelated' });

    await withAuthServer({ goodToken: currentToken }, async ({ serverUrl }) => {
      const targetPaths = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
      const mainPaths = resolveStackCredentialPaths({
        cliHomeDir: mainCliHomeDir,
        serverUrl,
        env: {
          ...env,
          HAPPIER_STACK_STACK: 'main',
          HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default',
        },
      });
      const unrelatedPath = join(cliHomeDir, 'servers', 'qa-deep-local', 'access.key');

      await writeAccessKeyFile(unrelatedPath, unrelatedToken);
      await writeAccessKeyFile(mainPaths.serverScopedPath, currentToken);

      await assert.rejects(
        startLocalDaemonWithAuth({
          cliBin,
          cliEntrypoint: join(cliDir, 'dist', 'index.mjs'),
          cliHomeDir,
          internalServerUrl: serverUrl,
          publicServerUrl: serverUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env,
          stackName,
        }),
        /Failed to auto re-seed daemon credentials|Failed to start daemon|credentials were rejected by the server/i,
      );

      const seededLegacyCredential = JSON.parse(await readFile(targetPaths.legacyPath, 'utf-8'));
      const seededServerCredential = JSON.parse(await readFile(targetPaths.serverScopedPath, 'utf-8'));
      const unrelatedCredential = JSON.parse(await readFile(unrelatedPath, 'utf-8'));
      assert.equal(seededLegacyCredential.token, currentToken);
      assert.equal(seededServerCredential.token, currentToken);
      assert.equal(unrelatedCredential.token, unrelatedToken);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth streams daemon start output in TUI mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-stream-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    // Overwrite the stub to print a deterministic line on daemon start.
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
	const args = process.argv.slice(2);
	if (args[0] === 'daemon' && args[1] === 'start') {
	  console.log('stub daemon start');
	  process.exit(1);
	}
	process.exit(0);
	`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const env = {
  ...process.env,
  HAPPIER_STACK_TUI: '1',
  HAPPIER_STACK_AUTO_AUTH_SEED: '0',
  HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
  HAPPIER_STACK_CLI_BUILD: '1',
  HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '3000',
  HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
  HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
};

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliCommand: process.execPath,
    cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
    cliHomeDir: ${JSON.stringify(cliHomeDir)},
    internalServerUrl: 'http://127.0.0.1:4301',
    publicServerUrl: 'http://localhost:4301',
    isShuttingDown: () => false,
    forceRestart: true,
    env,
    stackName: 'dev',
  });
} catch {
  // Expected: stub exits non-zero and no daemon state is written.
}
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.match(res.stdout + res.stderr, /\[daemon\] stub daemon start/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps TUI alive when the daemon start wrapper exits by signal', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-signaled-start-'));

  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  process.kill(process.pid, 'SIGTERM');
  setInterval(() => {}, 1000);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

await startLocalDaemonWithAuth({
  cliBin: ${JSON.stringify(cliBin)},
  cliCommand: process.execPath,
  cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_TUI: '1',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    HAPPIER_STACK_DAEMON_LIFECYCLE_LOCK_TIMEOUT_MS: '1000',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8',
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /daemon start failed before the relay came up; keeping TUI running/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps TUI alive when the daemon log reports invalid auth', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-invalid-auth-'));

  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

await startLocalDaemonWithAuth({
  cliBin: ${JSON.stringify(cliBin)},
  cliCommand: process.execPath,
  cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_TUI: '1',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1000',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    HAPPIER_STACK_DAEMON_LIFECYCLE_LOCK_TIMEOUT_MS: '1000',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8',
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /daemon start failed before the relay came up; keeping TUI running/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps TUI alive when daemon start reports an installed background service conflict', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-service-conflict-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

await startLocalDaemonWithAuth({
  cliBin: ${JSON.stringify(cliBin)},
  cliCommand: process.execPath,
  cliCommandArgs: [${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}],
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_TUI: '1',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: ${JSON.stringify(PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS)},
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /\[daemon\] .*keeping TUI running\./);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth preserves installed-service ownership guidance outside TUI mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-guidance-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  const delayedOutput = spawn(process.execPath, ['-e', "setTimeout(() => { console.error('A background service is already installed for this relay.'); console.error('Use ' + String.fromCharCode(96) + 'happier service start' + String.fromCharCode(96) + ' to start the installed background service instead of starting a new relay runtime.'); console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.'); }, 3000);"], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  delayedOutput.unref();
  process.exit(1);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliHomeDir: ${JSON.stringify(cliHomeDir)},
    internalServerUrl: 'http://127.0.0.1:4301',
    publicServerUrl: 'http://localhost:4301',
    isShuttingDown: () => false,
    forceRestart: true,
    env: {
      ...process.env,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: ${JSON.stringify(String(DEFAULT_STACK_DAEMON_START_VERIFY_TIMEOUT_MS))},
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    },
    stackName: 'dev',
  });
  process.exit(0);
} catch (error) {
  console.error('CAUGHT_ERROR=' + JSON.stringify(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
`.trimStart(),
      'utf-8'
    );

    const res = await runNodeWithTimeout([runnerPath], { cwd: tmp, env: process.env, timeoutMs: 15_000 });
    assert.equal(res.timedOut, false, `${res.stdout}${res.stderr}`);
    assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
    assert.match(
      res.stderr,
      /CAUGHT_ERROR=.*Use `happier service start` to start the installed background service instead of starting a new relay runtime\./
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth recovers from installed-service conflict by starting the installed service owner', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-recover-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const launchAgentPath = join(tmp, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.default.plist');
    await mkdir(dirname(launchAgentPath), { recursive: true });
    await writeFile(launchAgentPath, '<plist version="1.0"></plist>\n', 'utf-8');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — ' + ${JSON.stringify(launchAgentPath)});
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}
if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const launchctlRunnerPath = join(tmp, 'launchctl-runner.mjs');
    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    await writeFile(
      launchctlRunnerPath,
      `
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
${JSON.stringify(process.execPath)} ${JSON.stringify(launchctlRunnerPath)}
exit 0
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        HAPPIER_STACK_REPO_DIR: tmp,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
    });

    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
    assert.ok(state.pid > 0, `expected a live daemon pid, got ${state.pid}`);

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /kickstart/);
    assert.match(launchctlLog, /com\.happier\.cli\.daemon\.default/);
    killDetachedProcessGroup(state.pid);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not bootstrap the installed service plist when the launchctl label is not loaded', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-bootstrap-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}
if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl-bootstrap.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const launchctlRunnerPath = join(tmp, 'launchctl-bootstrap-runner.mjs');
    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const bootstrapMarkerPath = join(tmp, 'bootstrap-loaded.marker');
    await writeFile(
      launchctlRunnerPath,
      `
import { writeFileSync } from 'node:fs';
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

writeFileSync(${JSON.stringify(bootstrapMarkerPath)}, '1\\n', 'utf-8');
spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
if [ "$1" = "kickstart" ]; then
  exit 113
fi
if [ "$1" = "start" ]; then
  exit 113
fi
if [ "$1" = "bootstrap" ]; then
  ${JSON.stringify(process.execPath)} ${JSON.stringify(launchctlRunnerPath)}
  exit 0
fi
exit 1
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_REPO_DIR: tmp,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /installed background service conflict|Failed to start daemon/i,
    );

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /kickstart/);
    assert.match(launchctlLog, /^start/m);
    assert.doesNotMatch(launchctlLog, /^enable/m);
    assert.doesNotMatch(launchctlLog, /^bootstrap/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not enable a disabled installed service from daemon start recovery', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-enable-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await overwriteStubCliDist(
      cliDir,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}
if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}
process.exit(0);
`.trimStart(),
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl-enable.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    const launchctlRunnerPath = join(tmp, 'launchctl-enable-runner.mjs');
    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const enabledMarkerPath = join(tmp, 'launchctl-enabled.marker');
    await writeFile(
      launchctlRunnerPath,
      `
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
if [ "$1" = "kickstart" ]; then
  exit 113
fi
if [ "$1" = "start" ]; then
  exit 113
fi
if [ "$1" = "enable" ]; then
  : > ${JSON.stringify(enabledMarkerPath)}
  exit 0
fi
if [ "$1" = "bootstrap" ]; then
  if [ ! -f ${JSON.stringify(enabledMarkerPath)} ]; then
    echo "Bootstrap failed: 5: Input/output error" 1>&2
    exit 5
  fi
  ${JSON.stringify(process.execPath)} ${JSON.stringify(launchctlRunnerPath)}
  exit 0
fi
exit 1
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_REPO_DIR: tmp,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /installed background service conflict|Failed to start daemon/i,
    );

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /kickstart/);
    assert.match(launchctlLog, /^start/m);
    assert.doesNotMatch(launchctlLog, /^enable/m);
    assert.doesNotMatch(launchctlLog, /^bootstrap/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not repair a stale installed service definition from daemon start recovery', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-repair-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const serviceRepairMarkerPath = join(tmp, 'service-repair.marker');
    const serviceCommandLogPath = join(tmp, 'service-command.log');
    const serviceStartRunnerPath = join(tmp, 'service-start-runner.mjs');
    await writeFile(
      serviceStartRunnerPath,
      `
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(serviceCommandLogPath)}, \`\${args.join(' ')} [channel=\${process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? ''}]\\n\`, 'utf-8');

if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}

if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}

if (args[0] === 'service' && args[1] === 'repair' && args.includes('--yes')) {
  writeFileSync(${JSON.stringify(serviceRepairMarkerPath)}, 'repaired\\n', 'utf-8');
  process.exit(0);
}

if (args[0] === 'service' && args[1] === 'start') {
  if (!existsSync(${JSON.stringify(serviceRepairMarkerPath)})) {
    process.exit(41);
  }
  const child = spawn(process.execPath, [${JSON.stringify(serviceStartRunnerPath)}], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
    );

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl-repair.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
exit 113
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_REPO_DIR: tmp,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /hstack service repair --yes/i,
    );

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /^kickstart/m);
    assert.match(launchctlLog, /^start/m);
    assert.doesNotMatch(launchctlLog, /^enable/m);
    assert.doesNotMatch(launchctlLog, /^bootstrap/m);

    const serviceCommands = await readFile(serviceCommandLogPath, 'utf-8');
    assert.match(serviceCommands, /^daemon start \[channel=\]$/m);
    assert.doesNotMatch(serviceCommands, /^service repair --yes/m);
    assert.doesNotMatch(serviceCommands, /^service start/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth diagnoses a launchctl-missing installed service label without repairing it', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('launchctl recovery path is macOS-only');
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-conflict-materialization-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const launchAgentPath = join(tmp, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.default.plist');
    await mkdir(dirname(launchAgentPath), { recursive: true });
    await writeFile(launchAgentPath, '<plist version="1.0"></plist>\n', 'utf-8');

    const serviceCommandLogPath = join(tmp, 'service-command.log');
    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(serviceCommandLogPath)}, \`\${args.join(' ')} [channel=\${process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? ''}]\\n\`, 'utf-8');

if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — ${launchAgentPath}');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}

if (args[0] === 'daemon' && (args[1] === 'stop' || args[1] === 'status')) {
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
    );

    const fakeBinDir = join(tmp, 'fake-bin');
    await mkdir(fakeBinDir, { recursive: true });
    const launchctlLogPath = join(tmp, 'launchctl-materialization.log');
    const launchctlPath = join(fakeBinDir, 'launchctl');
    await writeFile(
      launchctlPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(launchctlLogPath)}
if [ "$1" = "kickstart" ] || [ "$1" = "start" ]; then
  echo 'Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501' 1>&2
  exit 113
fi
if [ "$1" = "print" ]; then
  echo 'Could not find service "com.happier.cli.daemon.default" in domain for user gui: 501' 1>&2
  exit 113
fi
exit 1
`,
      'utf-8'
    );
    await chmod(launchctlPath, 0o755);

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_REPO_DIR: tmp,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /launchd does not currently know label|service repair --yes/i,
    );

    const launchctlLog = await readFile(launchctlLogPath, 'utf-8');
    assert.match(launchctlLog, /^kickstart/m);
    assert.match(launchctlLog, /^start/m);
    assert.match(launchctlLog, /^print/m);
    assert.doesNotMatch(launchctlLog, /^enable/m);
    assert.doesNotMatch(launchctlLog, /^bootstrap/m);

    const serviceCommands = await readFile(serviceCommandLogPath, 'utf-8');
    assert.match(serviceCommands, /^daemon start \[channel=\]$/m);
    assert.doesNotMatch(serviceCommands, /^service repair --yes/m);
    assert.doesNotMatch(serviceCommands, /^service start/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth does not repair service-managed owner conflicts reported by daemon ownership preflight', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-owner-conflict-repair-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const serviceRepairMarkerPath = join(tmp, 'service-repair.marker');
    const serviceCommandLogPath = join(tmp, 'service-command.log');
    const serviceStartRunnerPath = join(tmp, 'service-start-runner.mjs');
    await writeFile(
      serviceStartRunnerPath,
      `
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

spawnDaemonLikeProcess({
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  statePaths: [${JSON.stringify(statePath)}],
});
      `.trimStart(),
      'utf-8'
    );
    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(serviceCommandLogPath)}, \`\${args.join(' ')} [channel=\${process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL ?? ''}]\\n\`, 'utf-8');

if (args[0] === 'daemon' && args[1] === 'start') {
  const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
  const logsDir = \`\${home}/logs\`;
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    \`\${logsDir}/\${Date.now()}-pid-\${process.pid}-daemon.log\`,
    [
      'The current relay owner is managed by a background service.',
      '  Current owner: background service',
      '  Current release channel: stable',
      '  Current CLI version: 0.2.0',
      '  Background service label: com.happier.cli.daemon.default',
      '  Use \`happier service stop\` instead of \`happier daemon stop\`.',
      '',
    ].join('\\n'),
    'utf-8',
  );
  console.error('The current relay owner is managed by a background service.');
  console.error('  Current owner: background service');
  console.error('  Current release channel: stable');
  console.error('  Current CLI version: 0.2.0');
  console.error('  Background service label: com.happier.cli.daemon.default');
  console.error('  Use \`happier service stop\` instead of \`happier daemon stop\`.');
  process.exit(1);
}

if (args[0] === 'daemon' && args[1] === 'stop') {
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'status') {
  process.exit(0);
}

if (args[0] === 'service' && args[1] === 'repair' && args.includes('--yes')) {
  writeFileSync(${JSON.stringify(serviceRepairMarkerPath)}, 'repaired\\n', 'utf-8');
  process.exit(0);
}

if (args[0] === 'service' && args[1] === 'start') {
  if (!existsSync(${JSON.stringify(serviceRepairMarkerPath)})) {
    process.exit(41);
  }
  const child = spawn(process.execPath, [${JSON.stringify(serviceStartRunnerPath)}], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
    );

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl: 'http://127.0.0.1:4301',
        publicServerUrl: 'http://localhost:4301',
        isShuttingDown: () => false,
        forceRestart: true,
        env: {
          ...createFixtureStackEnv(tmp),
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '1',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: PROCESS_BACKED_DAEMON_FIXTURE_TIMEOUT_MS,
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        },
        stackName: 'dev',
      }),
      /Use `happier service stop` instead of `happier daemon stop`\./,
    );

    const serviceCommands = await readFile(serviceCommandLogPath, 'utf-8');
    assert.match(serviceCommands, /^daemon start \[channel=\]$/m);
    assert.doesNotMatch(serviceCommands, /^service repair --yes/m);
    assert.doesNotMatch(serviceCommands, /^service start/m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth surfaces already-running daemon in TUI mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-running-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';

const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
const dummy = spawnDaemonLikeProcess({
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  statePaths: [statePath],
});

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env: {
      ...process.env,
      HAPPIER_STACK_TUI: '1',
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
} finally {
  try {
    process.kill(-dummy.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.match(res.stdout + res.stderr, /\[daemon\] .*already running/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth preserves an existing running daemon when requested', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-preserve-running-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'runner-preserve.mjs');
    await writeFile(
      runnerPath,
      `
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
const staleServerUrl = 'http://127.0.0.1:4300';
const publicServerUrl = 'http://localhost:4301';
const control = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.statusCode = 401;
  res.end();
});
await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));

const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e6)'], {
  env: {
    ...process.env,
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_SERVER_URL: staleServerUrl,
    HAPPIER_WEBAPP_URL: publicServerUrl,
  },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});

mkdirSync(join(cliHomeDir, 'servers', 'stack_dev__id_default'), { recursive: true });
writeFileSync(
  join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json'),
  JSON.stringify({
    pid: dummy.pid,
    httpPort: control.address().port,
    controlToken: 'state-token',
    startedAt: Date.now(),
    startedWithCliVersion: 'test',
  }) + '\\n',
  'utf-8'
);

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    preserveExistingRunning: true,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '200',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '10',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
  process.kill(dummy.pid, 0);
  console.log('dummy-alive');
} finally {
  await new Promise((resolve) => control.close(resolve));
  try {
    process.kill(-dummy.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}
`.trimStart(),
      'utf-8',
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr, /dummy-alive/);
    assert.match(res.stdout + res.stderr, /keeping existing daemon/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth accepts a repaired background-service-owned daemon when stack home matches even without explicit server env vars', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-running-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliCommandLogPath = join(tmp, 'cli-command.log');

    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync } from 'node:fs';

appendFileSync(${JSON.stringify(cliCommandLogPath)}, process.argv.slice(2).join(' ') + '\\n', 'utf-8');
process.exit(0);
      `.trimStart(),
      'utf-8',
    );

    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'service-owned-runner.mjs');
    await writeFile(
      runnerPath,
      `
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';

const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
const dummy = spawnDaemonLikeProcess({
  cliHomeDir,
  statePaths: [statePath],
  env: {
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_SERVICE_LABEL: 'com.happier.cli.daemon.default',
  },
});

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
} finally {
  try {
    process.kill(-dummy.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}
      `.trimStart(),
      'utf-8',
    );

    const result = await runNode([runnerPath], {
      cwd: tmp,
      env: {
        ...process.env,
      },
    });

    assert.equal(result.code, 0, `expected exit 0, got ${result.code}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    assert.equal(existsSync(cliCommandLogPath), false, 'expected no daemon stop/start command when the service-owned daemon already matches the stack home');
    assert.match(result.stdout, /daemon already running for stack home/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth still restarts a background-service-owned daemon when ps exposes a different server URL', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-mismatch-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliCommandLogPath = join(tmp, 'cli-command.log');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const daemonStatePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    await overwriteStubCliDist(
      cliDir,
      `
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { killDetachedProcessGroup, spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cliCommandLogPath)}, args.join(' ') + '\\n', 'utf-8');

if (args[0] === 'daemon' && args[1] === 'stop') {
  try {
    const state = JSON.parse(readFileSync(${JSON.stringify(daemonStatePath)}, 'utf-8'));
    killDetachedProcessGroup(Number(state?.pid));
  } catch {
    // The daemon may already be stopped.
  }
  rmSync(${JSON.stringify(daemonStatePath)}, { force: true });
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'start') {
  spawnDaemonLikeProcess({
    cliHomeDir: ${JSON.stringify(join(tmp, 'stack', 'cli'))},
    statePaths: [${JSON.stringify(daemonStatePath)}],
    internalServerUrl: 'http://127.0.0.1:4301',
    publicServerUrl: 'http://localhost:4301',
  });
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
    );

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'service-owned-mismatch-runner.mjs');
    await writeFile(
      runnerPath,
      `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};
import { spawnDaemonLikeProcess } from ${JSON.stringify(DAEMON_TEST_PROCESS_HELPER_PATH)};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const statePath = ${JSON.stringify(daemonStatePath)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';

const existing = spawnDaemonLikeProcess({
  cliHomeDir,
  statePaths: [statePath],
  internalServerUrl: 'http://127.0.0.1:9999',
  publicServerUrl,
  env: {
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_SERVICE_LABEL: 'com.happier.cli.daemon.default',
  },
});

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => false,
    forceRestart: false,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '1',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });

  const currentState = JSON.parse(readFileSync(statePath, 'utf-8'));
  assert.notEqual(currentState.pid, existing.pid);
} finally {
  try {
    process.kill(-existing.pid, 'SIGKILL');
  } catch {
    // ignore
  }

  try {
    const currentState = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (currentState?.pid && currentState.pid !== existing.pid) {
      process.kill(-currentState.pid, 'SIGKILL');
    }
  } catch {
    // ignore
  }
}
      `.trimStart(),
      'utf-8',
    );

    const result = await runNode([runnerPath], {
      cwd: tmp,
      env: {
        ...process.env,
      },
    });

    assert.equal(result.code, 0, `expected exit 0, got ${result.code}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    const serviceCommands = await readFile(cliCommandLogPath, 'utf-8');
    assert.match(serviceCommands, /^daemon stop$/m);
    assert.match(serviceCommands, /^daemon start$/m);
    assert.match(result.stderr, /daemon is running with a different stack HAPPIER_SERVER_URL mismatch; restarting/);
    assert.doesNotMatch(result.stderr, /ownership could not be proven/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth allows slower binary daemon startups by default', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-start-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);

    await writeFile(
      cliCommandScript,
      buildDelayedDaemonStartCliScript({ cliHomeDir, startDelayMs: 16_000 }),
      'utf-8',
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth allows slower runtime JS daemon startups by default', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-js-start-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);

    await writeFile(
      cliCommandScript,
      buildDelayedDaemonStartCliScript({ cliHomeDir, startDelayMs: 12_000 }),
      'utf-8',
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: cliCommandScript,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth allows slower source daemon startups by default', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-source-start-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const childPidPath = join(tmp, 'daemon-child.pid');
  const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');

  try {
    const monoRoot = tmp;
    const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
      packageJsonContent: '{}\n',
      binHappierScript: 'process.exit(42);\n',
      distIndexScript: buildDelayedDaemonStartCliScript({
        cliHomeDir,
        startDelayMs: 6_000,
        childPidPath,
      }),
    });
    const cliBin = join(cliBinDir, 'happier.mjs');

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...createFixtureStackEnv(tmp),
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
  } finally {
    try {
      const pid = Number(await readFile(childPidPath, 'utf-8'));
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth tolerates transient non-zero direct-executable starts when the daemon becomes running', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-runtime-nonzero-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);

    await writeFile(
      cliCommandScript,
      buildDelayedDaemonStartCliScript({ cliHomeDir, startDelayMs: 2_000, startExitCode: 1 }),
      'utf-8',
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(typeof state.pid, 'number');
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // ignore
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth gives nested daemon start the stack-owned readiness budget', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-nested-start-budget-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const childPidPath = join(tmp, 'daemon.pid');
  const outcomePath = join(tmp, 'nested-start-outcome.json');
  let childPid = null;

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);
    await writeFile(
      cliCommandScript,
      buildBudgetBoundDaemonStartCliScript({
        cliHomeDir,
        startDelayMs: 80,
        childPidPath,
        outcomePath,
      }),
      'utf-8',
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: process.execPath,
      cliCommandArgs: [cliCommandScript],
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: {
        ...process.env,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '20',
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '1',
        HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1000',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      },
      stackName: 'dev',
      cliIdentity: 'default',
    });

    childPid = Number(await readFile(childPidPath, 'utf-8'));
    const outcome = JSON.parse(await readFile(outcomePath, 'utf-8'));
    assert.deepEqual(outcome, { outcome: 'started', waitMs: 1000 });
  } finally {
    if (Number.isFinite(childPid) && childPid > 1) {
      try {
        killDetachedProcessGroup(childPid, 'SIGKILL');
      } catch {
        // already stopped by the fixture cleanup
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth returns once a synchronous daemon start command becomes stably running', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-sync-running-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  const cliBin = join(tmp, 'bin', 'happier');
  const cliCommandScript = join(tmp, 'cli-command.mjs');
  const runnerPath = join(tmp, 'runner.mjs');

  try {
    await mkdir(dirname(cliBin), { recursive: true });
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
    await writeFile(cliBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(cliBin, 0o755);

    await writeFile(
      cliCommandScript,
      buildSynchronousDaemonStartCliScript({ cliHomeDir, startDelayMs: 250 }),
      'utf-8',
    );

    await writeFile(
      runnerPath,
      `
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const statePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');

await startLocalDaemonWithAuth({
  cliBin: ${JSON.stringify(cliBin)},
  cliCommand: ${JSON.stringify(cliCommandScript)},
  cliHomeDir,
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_STACK: 'dev',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1500',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
  },
  stackName: 'dev',
  cliIdentity: 'default',
});

const state = JSON.parse(await readFile(statePath, 'utf-8'));
console.log(JSON.stringify({ ok: true, pid: state.pid }));
process.kill(state.pid, 'SIGTERM');
      `.trimStart(),
      'utf-8'
    );

    const res = await runNodeWithTimeout([runnerPath], {
      cwd: tmp,
      env: process.env,
      timeoutMs: 15_000,
    });

    assert.equal(res.timedOut, false, `runner should not hang once daemon becomes running\n${res.stdout}\n${res.stderr}`);
    assert.equal(res.code, 0, `runner should exit cleanly\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /"ok":true/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('checkDaemonState ignores running daemon state from a different active server scope', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-fallback-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  await mkdir(cliHomeDir, { recursive: true });

  const dummy = spawnDetachedInlineNodeTestProcess('setInterval(()=>{}, 1e6)', {
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_SERVER_URL: 'http://127.0.0.1:4301',
      HAPPIER_WEBAPP_URL: 'http://localhost:4301',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    const serverDir = join(cliHomeDir, 'servers', 'stack_dev__id_default');
    await mkdir(serverDir, { recursive: true });
    await writeFile(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify({ pid: dummy.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\n',
      'utf-8'
    );

    const env = {
      ...process.env,
      HAPPIER_ACTIVE_SERVER_ID: 'stack_dev2__id_default',
    };
    const state = checkDaemonState(cliHomeDir, { serverUrl: 'http://127.0.0.1:4301', env });
    assert.deepEqual(state, { status: 'stopped', pid: null });
  } finally {
    try {
      process.kill(-dummy.pid, 'SIGTERM');
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
