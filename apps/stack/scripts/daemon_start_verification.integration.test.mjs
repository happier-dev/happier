import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDaemonState, startLocalDaemonWithAuth } from './daemon.mjs';

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

async function writeStubHappyCli({ cliDir }) {
  await mkdir(join(cliDir, 'bin'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });
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
  await writeFile(join(cliDir, 'dist', 'index.mjs'), distScript.trimStart(), 'utf-8');
  await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');

  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  // If daemon.mjs accidentally invokes bin/happier.mjs, fail loudly.
  await writeFile(cliBin, 'process.exit(42);\n', 'utf-8');
  return cliBin;
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

test('checkDaemonState falls back to any running daemon state when active server scope differs', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-state-fallback-'));
  const cliHomeDir = join(tmp, 'stack', 'cli');
  await mkdir(cliHomeDir, { recursive: true });

  const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e6)'], {
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_SERVER_URL: 'http://127.0.0.1:4301',
      HAPPIER_WEBAPP_URL: 'http://localhost:4301',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
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
    assert.equal(state.status, 'running');
    assert.equal(state.pid, dummy.pid);
  } finally {
    try {
      process.kill(-dummy.pid, 'SIGTERM');
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
