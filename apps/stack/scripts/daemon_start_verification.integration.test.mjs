import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { mkdtemp, chmod, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDaemonState, startLocalDaemonWithAuth } from './daemon.mjs';
import { killDetachedProcessGroup } from './testkit/core/spawn_daemon_like_process.mjs';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { resolveStackCredentialPaths } from './utils/auth/credentials_paths.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

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

function runNodeWithTimeout(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawnDetachedTestProcess(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
    };

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

    const env = {
      ...process.env,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
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
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '1',
      HAPPIER_STACK_CLI_BUILD: '0',
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

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
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
  console.error('    com.happier.cli.daemon.default (publicdev, default-following) — /Users/tester/Library/LaunchAgents/com.happier.cli.daemon.default.plist');
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
      HAPPIER_STACK_CLI_BUILD: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '1',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    },
    stackName: 'dev',
  });
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`.trimStart(),
      'utf-8'
    );

    const res = await runNode([runnerPath], { cwd: tmp, env: process.env });
    assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
    assert.match(
      res.stdout + res.stderr,
      /Use `happier service start` to start the installed background service instead of starting a new relay runtime\./
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
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
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
      'utf-8'
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
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
        HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '250',
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
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
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
      'utf-8'
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
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '0',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '250',
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
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
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
      'utf-8'
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
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '0',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '250',
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
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
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
      'utf-8'
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
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '0',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '400',
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
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
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
      'utf-8'
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
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '0',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '250',
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
    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
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
      'utf-8'
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
          ...process.env,
          HAPPIER_STACK_STACK: 'dev',
          HAPPIER_STACK_AUTO_AUTH_SEED: '0',
          HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
          HAPPIER_STACK_CLI_BUILD: '0',
          HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '400',
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
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';

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
  JSON.stringify({ pid: dummy.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\\n',
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

test('startLocalDaemonWithAuth accepts a repaired background-service-owned daemon when stack home matches even without explicit server env vars', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-service-running-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    await writeStubHappyCli({ cliDir });
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const cliCommandLogPath = join(tmp, 'cli-command.log');

    await writeFile(
      join(cliDir, 'dist', 'index.mjs'),
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
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';

const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e6)'], {
  env: {
    ...process.env,
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_SERVICE_LABEL: 'com.happier.cli.daemon.default',
  },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});

mkdirSync(join(cliHomeDir, 'servers', 'stack_dev__id_default'), { recursive: true });
writeFileSync(
  join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json'),
  JSON.stringify({ pid: dummy.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\\n',
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
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
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
    const distEntrypointPath = join(cliDir, 'dist', 'index.mjs');
    const daemonStatePath = join(cliHomeDir, 'servers', 'stack_dev__id_default', 'daemon.state.json');
    await writeFile(
      distEntrypointPath,
      `
import { appendFileSync } from 'node:fs';
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cliCommandLogPath)}, args.join(' ') + '\\n', 'utf-8');

if (args[0] === 'daemon' && args[1] === 'stop') {
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
      'utf-8',
    );

    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), 'seed-access-key\n', 'utf-8');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

    const runnerPath = join(tmp, 'service-owned-mismatch-runner.mjs');
    await writeFile(
      runnerPath,
      `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalDaemonWithAuth } from ${JSON.stringify(join(rootDir, 'scripts', 'daemon.mjs'))};

const cliHomeDir = ${JSON.stringify(cliHomeDir)};
const statePath = ${JSON.stringify(daemonStatePath)};
const internalServerUrl = 'http://127.0.0.1:4301';
const publicServerUrl = 'http://localhost:4301';

const existing = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e6)'], {
  env: {
    ...process.env,
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_SERVICE_LABEL: 'com.happier.cli.daemon.default',
    HAPPIER_SERVER_URL: 'http://127.0.0.1:9999',
  },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});

mkdirSync(join(cliHomeDir, 'servers', 'stack_dev__id_default'), { recursive: true });
writeFileSync(
  statePath,
  JSON.stringify({ pid: existing.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\\n',
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
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
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
    assert.match(result.stderr, /daemon is running but pointed at a different server URL; restarting/);
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
setTimeout(() => {
  const serverDir = join(${JSON.stringify(cliHomeDir)}, 'servers', 'stack_dev__id_default');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(
    join(serverDir, 'daemon.state.json'),
    JSON.stringify({ pid: process.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\\\\n',
    'utf-8'
  );
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
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
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
setTimeout(() => {
  const serverDir = join(${JSON.stringify(cliHomeDir)}, 'servers', 'stack_dev__id_default');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(
    join(serverDir, 'daemon.state.json'),
    JSON.stringify({ pid: process.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\\\\n',
    'utf-8'
  );
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
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
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
setTimeout(() => {
  const serverDir = join(${JSON.stringify(cliHomeDir)}, 'servers', 'stack_dev__id_default');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(
    join(serverDir, 'daemon.state.json'),
    JSON.stringify({ pid: process.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\\\\n',
    'utf-8'
  );
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
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
        HAPPIER_STACK_CLI_BUILD: '0',
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
      `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';
if (sub === 'stop') process.exit(0);
if (sub === 'status') process.exit(1);

if (sub === 'start') {
  setTimeout(() => {
    const serverDir = join(${JSON.stringify(cliHomeDir)}, 'servers', 'stack_dev__id_default');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify({ pid: process.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test' }) + '\\n',
      'utf-8'
    );
  }, 250);
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
      `.trimStart(),
      'utf-8'
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
    HAPPIER_STACK_CLI_BUILD: '0',
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
      timeoutMs: 4_000,
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
