import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, chmod, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkDaemonState,
  matchDaemonEnvLine,
  resolveStackDaemonStartVerifyTimeoutMs,
  resolveAttendedStartupTimeoutMs,
  shouldContinueAttendedDaemonStartVerification,
  startLocalDaemonWithAuth,
} from './daemon.mjs';
import { killDetachedProcessGroup } from './testkit/core/spawn_daemon_like_process.mjs';
import { spawnDetachedInlineNodeTestProcess } from './testkit/core/spawn_test_process.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr }));
  });
}

function createStubStackEnv(overrides = {}) {
  return {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: '',
    HAPPIER_STACK_CLI_ROOT_DIR: '',
    HAPPIER_STACK_TUI: '',
    HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '',
    HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: '',
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: '',
    HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '',
    ...overrides,
  };
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);
const DAEMON_TEST_PROCESS_HELPER_PATH = join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs');

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
  return join(cliBinDir, 'happier.mjs');
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

test('startLocalDaemonWithAuth treats daemon start exit=0 as failure when daemon never becomes running', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-start-verify-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = createStubStackEnv({
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    });

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
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

test('startLocalDaemonWithAuth fails fast when stack-scoped auth is stale and only a different-account fallback is valid', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-auth-stale-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliHomeDir = join(tmp, 'stack', 'cli');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const env = createStubStackEnv({
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: 'stack_dev__id_default',
    });

    const staleToken = createTestJwt({ sub: 'account-a', jti: 'stale' });
    const validOtherAccountToken = createTestJwt({ sub: 'account-b', jti: 'valid' });

    await withAuthServer({ goodToken: validOtherAccountToken }, async ({ serverUrl }) => {
      const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
      await writeAccessKeyFile(resolved.serverScopedPath, staleToken);
      await writeAccessKeyFile(resolved.urlHashServerScopedPath, validOtherAccountToken);

      await assert.rejects(
        startLocalDaemonWithAuth({
          cliBin,
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

    const env = createStubStackEnv({
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '1',
      HAPPIER_STACK_CLI_BUILD: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      HAPPIER_ACTIVE_SERVER_ID: `stack_${stackName}__id_default`,
    });

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

test('startLocalDaemonWithAuth streams daemon start output in TUI mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-tui-stream-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });

    // Overwrite the stub to print a deterministic line on daemon start.
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
      `
	const args = process.argv.slice(2);
	if (args[0] === 'daemon' && args[1] === 'start') {
	  console.log('stub daemon start');
	  process.exit(1);
	}
	process.exit(0);
	`.trimStart(),
      'utf-8'
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
  HAPPIER_STACK_CLI_BUILD: '0',
  HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1',
  HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
  HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
};

try {
  await startLocalDaemonWithAuth({
    cliBin: ${JSON.stringify(cliBin)},
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

    const res = await runNode([runnerPath], { cwd: tmp, env: createStubStackEnv() });
    assert.match(res.stdout + res.stderr, /\[daemon\] stub daemon start/);
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
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  console.error('A background service is already installed for this relay.');
  console.error('Use \`happier service start\` to start the installed background service instead of starting a new relay runtime.');
  console.error('If you want to start a manual relay runtime, stop or replace the installed background service first.');
  process.exit(1);
}
process.exit(0);
`.trimStart(),
      'utf-8'
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
    HAPPIER_STACK_CLI_BUILD: '0',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: createStubStackEnv() });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /\[daemon\] .*keeping TUI running\./);
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
    const cliEntrypoint = join(cliDir, 'dist', 'index.mjs');
    await writeFile(
      cliEntrypoint,
      `
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'start') {
  process.kill(process.pid, 'SIGTERM');
  setInterval(() => {}, 1000);
}
process.exit(0);
`.trimStart(),
      'utf-8',
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
  cliCommandArgs: [${JSON.stringify(cliEntrypoint)}],
  cliHomeDir: ${JSON.stringify(cliHomeDir)},
  internalServerUrl: 'http://127.0.0.1:4301',
  publicServerUrl: 'http://localhost:4301',
  isShuttingDown: () => false,
  forceRestart: true,
  env: {
    ...process.env,
    HAPPIER_STACK_TUI: '1',
    HAPPIER_STACK_STACK: 'dev',
    HAPPIER_STACK_AUTO_AUTH_SEED: '0',
    HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
    HAPPIER_STACK_CLI_BUILD: '0',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '20',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8',
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: createStubStackEnv() });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /daemon start failed before the relay came up; keeping TUI running/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth keeps TUI alive when the daemon log reports invalid auth', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
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
    HAPPIER_STACK_CLI_BUILD: '0',
    HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
    HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
  },
  stackName: 'dev',
});
`.trimStart(),
      'utf-8',
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: createStubStackEnv() });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, /daemon start failed before the relay came up; keeping TUI running/);
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
	import { spawn } from 'node:child_process';
	import http from 'node:http';
	import { mkdirSync, writeFileSync } from 'node:fs';
	import { join } from 'node:path';
	import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
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

// Simulate an already-running daemon by writing a daemon.state.json pointing at a long-lived process
// that contains the expected env vars in its ps output (daemonEnvMatches()).
const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e6)'], {
  env: {
    ...process.env,
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_SERVER_URL: internalServerUrl,
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
    env: {
      ...process.env,
      HAPPIER_STACK_TUI: '1',
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });
} finally {
  await new Promise((resolve) => control.close(resolve));
  try {
    process.kill(-dummy.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: createStubStackEnv() });
    assert.match(res.stdout + res.stderr, /\[daemon\] .*already running/i);
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
    const credentialContents = 'credential-must-remain-unchanged\n';

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
      ...createStubStackEnv(),
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

test('startLocalDaemonWithAuth preserves an existing running daemon when requested', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

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
      HAPPIER_STACK_CLI_BUILD: '0',
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

    const res = await runNode([runnerPath], { cwd: tmp, env: createStubStackEnv() });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr, /dummy-alive/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('startLocalDaemonWithAuth preserves a live daemon across a transient control ping miss', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-unpingable-running-'));
  let dummy = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });
    const cliHomeDir = join(tmp, 'stack', 'cli');
    const internalServerUrl = 'http://127.0.0.1:4301';
    const publicServerUrl = 'http://localhost:4301';
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e6)'], {
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: internalServerUrl,
        HAPPIER_WEBAPP_URL: publicServerUrl,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });

    const stateDir = join(cliHomeDir, 'servers', 'stack_dev__id_default');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'daemon.state.json'),
      JSON.stringify({
        pid: dummy.pid,
        httpPort: 1,
        controlToken: 'state-token',
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
      }) + '\n',
      'utf-8',
    );

    await assert.doesNotReject(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        isShuttingDown: () => false,
        forceRestart: false,
        preserveExistingRunning: true,
        env: createStubStackEnv({
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '0',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '200',
          HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '10',
          HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
        }),
        stackName: 'dev',
      }),
    );
    assert.doesNotThrow(() => process.kill(dummy.pid, 0), 'transient control failure must not kill the live daemon');
  } finally {
    if (dummy?.pid) {
      try {
        process.kill(-dummy.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
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
      `
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      \`
	const { mkdirSync, writeFileSync } = require('node:fs');
	const { join } = require('node:path');
	const http = require('node:http');
	setTimeout(() => {
	  const serverDir = join(${JSON.stringify(cliHomeDir)}, 'servers', 'stack_dev__id_default');
	  mkdirSync(serverDir, { recursive: true });
	  const control = http.createServer((req, res) => {
	    if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
	      res.setHeader('content-type', 'application/json');
	      res.end(JSON.stringify({ status: 'ok' }));
	      return;
	    }
	    res.statusCode = 401;
	    res.end();
	  });
	  control.listen(0, '127.0.0.1', () => {
	    writeFileSync(
	      join(serverDir, 'daemon.state.json'),
	      JSON.stringify({
	        pid: process.pid,
	        httpPort: control.address().port,
	        controlToken: 'state-token',
	        startedAt: Date.now(),
	        startedWithCliVersion: 'test',
	      }) + '\\\\n',
	      'utf-8'
	    );
	  });
	}, 16000);
	setInterval(() => {}, 1000);
\`,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }
  );
  child.unref();
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
      'utf-8'
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
      env: createStubStackEnv({
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      }),
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
      `
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      \`
	const { mkdirSync, writeFileSync } = require('node:fs');
	const { join } = require('node:path');
	const http = require('node:http');
	setTimeout(() => {
	  const serverDir = join(${JSON.stringify(cliHomeDir)}, 'servers', 'stack_dev__id_default');
	  mkdirSync(serverDir, { recursive: true });
	  const control = http.createServer((req, res) => {
	    if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
	      res.setHeader('content-type', 'application/json');
	      res.end(JSON.stringify({ status: 'ok' }));
	      return;
	    }
	    res.statusCode = 401;
	    res.end();
	  });
	  control.listen(0, '127.0.0.1', () => {
	    writeFileSync(
	      join(serverDir, 'daemon.state.json'),
	      JSON.stringify({
	        pid: process.pid,
	        httpPort: control.address().port,
	        controlToken: 'state-token',
	        startedAt: Date.now(),
	        startedWithCliVersion: 'test',
	      }) + '\\\\n',
	      'utf-8'
	    );
	  });
	}, 12000);
	setInterval(() => {}, 1000);
\`,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }
  );
  child.unref();
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
      'utf-8'
    );

    await startLocalDaemonWithAuth({
      cliBin,
      cliCommand: cliCommandScript,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:4301',
      publicServerUrl: 'http://localhost:4301',
      isShuttingDown: () => false,
      forceRestart: true,
      env: createStubStackEnv({
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      }),
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
      distIndexScript: `
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      \`
	const { mkdirSync, writeFileSync } = require('node:fs');
	const { join } = require('node:path');
	const http = require('node:http');
	writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid), 'utf-8');
	setTimeout(() => {
	  const serverDir = join(${JSON.stringify(cliHomeDir)}, 'servers', 'stack_dev__id_default');
	  mkdirSync(serverDir, { recursive: true });
	  const control = http.createServer((req, res) => {
	    if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
	      res.setHeader('content-type', 'application/json');
	      res.end(JSON.stringify({ status: 'ok' }));
	      return;
	    }
	    res.statusCode = 401;
	    res.end();
	  });
	  control.listen(0, '127.0.0.1', () => {
	    writeFileSync(
	      join(serverDir, 'daemon.state.json'),
	      JSON.stringify({
	        pid: process.pid,
	        httpPort: control.address().port,
	        controlToken: 'state-token',
	        startedAt: Date.now(),
	        startedWithCliVersion: 'test',
	      }) + '\\\\n',
	      'utf-8'
	    );
	  });
	}, 6000);
	setInterval(() => {}, 1000);
\`,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }
  );
  child.unref();
  process.exit(0);
}

process.exit(0);
      `.trimStart(),
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
      env: createStubStackEnv({
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      }),
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
      `
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      \`
	const { mkdirSync, writeFileSync } = require('node:fs');
	const { join } = require('node:path');
	const http = require('node:http');
	setTimeout(() => {
	  const serverDir = join(${JSON.stringify(cliHomeDir)}, 'servers', 'stack_dev__id_default');
	  mkdirSync(serverDir, { recursive: true });
	  const control = http.createServer((req, res) => {
	    if (req.method === 'POST' && req.url === '/ping' && req.headers['x-happier-daemon-token'] === 'state-token') {
	      res.setHeader('content-type', 'application/json');
	      res.end(JSON.stringify({ status: 'ok' }));
	      return;
	    }
	    res.statusCode = 401;
	    res.end();
	  });
	  control.listen(0, '127.0.0.1', () => {
	    writeFileSync(
	      join(serverDir, 'daemon.state.json'),
	      JSON.stringify({
	        pid: process.pid,
	        httpPort: control.address().port,
	        controlToken: 'state-token',
	        startedAt: Date.now(),
	        startedWithCliVersion: 'test',
	      }) + '\\\\n',
	      'utf-8'
	    );
	  });
	}, 2000);
	setInterval(() => {}, 1000);
\`,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }
  );
  child.unref();
  process.exit(1);
}

process.exit(0);
      `.trimStart(),
      'utf-8'
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
      env: createStubStackEnv({
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '50',
        HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
      }),
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

    const env = createStubStackEnv({
      HAPPIER_ACTIVE_SERVER_ID: 'stack_dev2__id_default',
    });
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
