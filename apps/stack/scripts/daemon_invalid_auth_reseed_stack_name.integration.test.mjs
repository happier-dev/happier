import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';

function encodeBase64Url(value) {
  return Buffer.from(value, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeToken({ sub, nonce = 'n' }) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({ sub, nonce }));
  return `${header}.${payload}.sig`;
}

function credentialFileContents(token) {
  return JSON.stringify({
    token,
    secret: Buffer.from('test-secret', 'utf-8').toString('base64'),
  }) + '\n';
}

async function writeStackEnv({ storageDir, stackName, env }) {
  const baseDir = join(storageDir, stackName);
  await mkdir(baseDir, { recursive: true });
  const lines = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  await writeFile(join(baseDir, 'env'), `${lines}\n`, 'utf-8');
  return baseDir;
}

async function writeStubHappyCli({ cliDir }) {
  await mkdir(join(cliDir, 'bin'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export {};\n', 'utf-8');
  await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');

  const script = `
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

const attemptsPath = join(home, 'start-attempt.txt');
const statePath = join(home, 'daemon.state.json');
const logsDir = join(home, 'logs');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(statePath)) {
    try {
      const pid = Number(JSON.parse(readFileSync(statePath, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
  }
  process.exit(0);
}

if (sub === 'status') {
  console.log('daemon: running');
  process.exit(0);
}

if (sub === 'start') {
  mkdirSync(logsDir, { recursive: true });

  let attempt = 0;
  if (existsSync(attemptsPath)) {
    attempt = Number(readFileSync(attemptsPath, 'utf-8').trim()) || 0;
  }
  attempt += 1;
  writeFileSync(attemptsPath, String(attempt) + '\\n', 'utf-8');

  if (attempt === 1) {
    const logPath = join(logsDir, \`\${Date.now()}-pid-\${process.pid}-daemon.log\`);
    writeFileSync(
      logPath,
      '[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1 {"message":"Request failed with status code 401","status":401}\\n',
      'utf-8'
    );
    process.exit(1);
  }

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(statePath, JSON.stringify({ pid: child.pid, httpPort: 0 }) + '\\n', 'utf-8');
  process.exit(0);
}

process.exit(0);
`;

  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  await writeFile(cliBin, script.trimStart(), 'utf-8');
  return cliBin;
}

test('invalid-auth auto-reseed uses resolved stack name instead of null placeholder', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-reseed-stack-name-'));
  try {
    const storageDir = join(tmp, 'storage');
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });

    const targetCliHome = join(storageDir, 'dev', 'cli');
    const sourceCliHome = join(storageDir, 'dev-auth', 'cli');
    await mkdir(targetCliHome, { recursive: true });
    await mkdir(sourceCliHome, { recursive: true });

    await writeFile(
      join(sourceCliHome, 'access.key'),
      credentialFileContents(makeToken({ sub: 'user-1', nonce: 'seed' })),
      'utf-8'
    );
    await writeFile(join(sourceCliHome, 'settings.json'), JSON.stringify({ machineId: 'source-machine' }) + '\n', 'utf-8');

    await writeStackEnv({
      storageDir,
      stackName: 'dev',
      env: {
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_SERVER_PORT: '4101',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: targetCliHome,
      },
    });
    await writeStackEnv({
      storageDir,
      stackName: 'dev-auth',
      env: {
        HAPPIER_STACK_STACK: 'dev-auth',
        HAPPIER_STACK_SERVER_PORT: '4102',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: sourceCliHome,
      },
    });

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTH_SEED_FROM: 'dev-auth',
      HAPPIER_STACK_AUTO_AUTH_SEED: '1',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
    };

    await assert.doesNotReject(async () => {
      await startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir: targetCliHome,
        internalServerUrl: 'http://127.0.0.1:4101',
        publicServerUrl: 'http://localhost:4101',
        isShuttingDown: () => false,
        forceRestart: true,
        env,
      });
    });

    assert.equal(existsSync(join(storageDir, 'null')), false);
    assert.equal(existsSync(join(targetCliHome, 'access.key')), true);
    const copiedAccessKey = await readFile(join(targetCliHome, 'access.key'), 'utf-8');
    assert.equal(
      copiedAccessKey,
      credentialFileContents(makeToken({ sub: 'user-1', nonce: 'seed' }))
    );

    await stopLocalDaemon({
      cliBin,
      internalServerUrl: 'http://127.0.0.1:4101',
      cliHomeDir: targetCliHome,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('invalid-auth auto-reseed overwrites stale target credentials', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-reseed-force-'));
  try {
    const storageDir = join(tmp, 'storage');
    const cliDir = join(tmp, 'apps', 'cli');
    const cliBin = await writeStubHappyCli({ cliDir });

    const targetCliHome = join(storageDir, 'dev', 'cli');
    const sourceCliHome = join(storageDir, 'dev-auth', 'cli');
    await mkdir(targetCliHome, { recursive: true });
    await mkdir(sourceCliHome, { recursive: true });

    await writeFile(
      join(targetCliHome, 'access.key'),
      credentialFileContents(makeToken({ sub: 'user-1', nonce: 'stale' })),
      'utf-8'
    );
    await writeFile(join(targetCliHome, 'settings.json'), JSON.stringify({ machineId: 'target-machine' }) + '\n', 'utf-8');
    await writeFile(
      join(sourceCliHome, 'access.key'),
      credentialFileContents(makeToken({ sub: 'user-1', nonce: 'seed' })),
      'utf-8'
    );
    await writeFile(join(sourceCliHome, 'settings.json'), JSON.stringify({ machineId: 'source-machine' }) + '\n', 'utf-8');

    await writeStackEnv({
      storageDir,
      stackName: 'dev',
      env: {
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_SERVER_PORT: '4201',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: targetCliHome,
      },
    });
    await writeStackEnv({
      storageDir,
      stackName: 'dev-auth',
      env: {
        HAPPIER_STACK_STACK: 'dev-auth',
        HAPPIER_STACK_SERVER_PORT: '4202',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: sourceCliHome,
      },
    });

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTH_SEED_FROM: 'dev-auth',
      HAPPIER_STACK_AUTO_AUTH_SEED: '1',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
    };

    await assert.doesNotReject(async () => {
      await startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir: targetCliHome,
        internalServerUrl: 'http://127.0.0.1:4201',
        publicServerUrl: 'http://localhost:4201',
        isShuttingDown: () => false,
        forceRestart: true,
        env,
      });
    });

    const copiedAccessKey = await readFile(join(targetCliHome, 'access.key'), 'utf-8');
    assert.equal(
      copiedAccessKey,
      credentialFileContents(makeToken({ sub: 'user-1', nonce: 'seed' }))
    );

    await stopLocalDaemon({
      cliBin,
      internalServerUrl: 'http://127.0.0.1:4201',
      cliHomeDir: targetCliHome,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('invalid-auth reseed does not fall back to main when configured seed credentials are stale', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-reseed-fallback-'));
  try {
    const storageDir = join(tmp, 'storage');
    const cliDir = join(tmp, 'apps', 'cli');

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await mkdir(join(cliDir, 'dist'), { recursive: true });
    await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export {};\n', 'utf-8');
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');

    const stub = `
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

const attemptsPath = join(home, 'start-attempt.txt');
const statePath = join(home, 'daemon.state.json');
const logsDir = join(home, 'logs');
  const accessPath = join(home, 'access.key');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(statePath)) {
    try {
      const pid = Number(JSON.parse(readFileSync(statePath, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
  }
  process.exit(0);
}

if (sub === 'status') {
  process.exit(0);
}

if (sub === 'start') {
  mkdirSync(logsDir, { recursive: true });
  let attempt = 0;
  if (existsSync(attemptsPath)) {
    attempt = Number(readFileSync(attemptsPath, 'utf-8').trim()) || 0;
  }
  attempt += 1;
  writeFileSync(attemptsPath, String(attempt) + '\\n', 'utf-8');

  const log401 = () => {
    const logPath = join(logsDir, \`\${Date.now()}-pid-\${process.pid}-daemon.log\`);
    writeFileSync(
      logPath,
      '[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1 {"message":"Request failed with status code 401","status":401}\\n',
      'utf-8'
    );
  };

  if (attempt === 1) {
    log401();
    process.exit(1);
  }

  const raw = existsSync(accessPath) ? readFileSync(accessPath, 'utf-8') : '';
  let sub = '';
  try {
    const token = JSON.parse(raw)?.token ?? '';
    const payloadB64 = String(token).split('.')[1] ?? '';
    const normalized = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
    sub = String(payload?.sub ?? '');
  } catch {}
  if (sub !== 'user-main') {
    log401();
    process.exit(1);
  }

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(statePath, JSON.stringify({ pid: child.pid, httpPort: 0 }) + '\\n', 'utf-8');
  process.exit(0);
}

process.exit(0);
`;
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await writeFile(cliBin, stub.trimStart(), 'utf-8');

    const targetCliHome = join(storageDir, 'dev', 'cli');
    const devAuthCliHome = join(storageDir, 'dev-auth', 'cli');
    const mainCliHome = join(storageDir, 'main', 'cli');
    await mkdir(targetCliHome, { recursive: true });
    await mkdir(devAuthCliHome, { recursive: true });
    await mkdir(mainCliHome, { recursive: true });

    await writeFile(
      join(targetCliHome, 'access.key'),
      credentialFileContents(makeToken({ sub: 'user-shared', nonce: 'target-stale' })),
      'utf-8'
    );
    await writeFile(
      join(devAuthCliHome, 'access.key'),
      credentialFileContents(makeToken({ sub: 'user-shared', nonce: 'seed-stale' })),
      'utf-8'
    );
    await writeFile(
      join(mainCliHome, 'access.key'),
      credentialFileContents(makeToken({ sub: 'user-main', nonce: 'seed-main' })),
      'utf-8'
    );
    await writeFile(join(devAuthCliHome, 'settings.json'), JSON.stringify({ machineId: 'dev-auth-machine' }) + '\n', 'utf-8');
    await writeFile(join(mainCliHome, 'settings.json'), JSON.stringify({ machineId: 'main-machine' }) + '\n', 'utf-8');

    await writeStackEnv({
      storageDir,
      stackName: 'dev',
      env: {
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_SERVER_PORT: '4301',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: targetCliHome,
      },
    });
    await writeStackEnv({
      storageDir,
      stackName: 'dev-auth',
      env: {
        HAPPIER_STACK_STACK: 'dev-auth',
        HAPPIER_STACK_SERVER_PORT: '4302',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: devAuthCliHome,
      },
    });
    await writeStackEnv({
      storageDir,
      stackName: 'main',
      env: {
        HAPPIER_STACK_STACK: 'main',
        HAPPIER_STACK_SERVER_PORT: '4303',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: mainCliHome,
      },
    });

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTH_SEED_FROM: 'dev-auth',
      HAPPIER_STACK_AUTO_AUTH_SEED: '1',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
    };

    await assert.rejects(
      async () => {
        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir: targetCliHome,
          internalServerUrl: 'http://127.0.0.1:4301',
          publicServerUrl: 'http://localhost:4301',
          isShuttingDown: () => false,
          forceRestart: true,
          env,
        });
      },
      /after auth re-seed/i
    );

    const copiedAccessKey = await readFile(join(targetCliHome, 'access.key'), 'utf-8');
    assert.equal(
      copiedAccessKey,
      credentialFileContents(makeToken({ sub: 'user-shared', nonce: 'seed-stale' }))
    );

    await stopLocalDaemon({
      cliBin,
      internalServerUrl: 'http://127.0.0.1:4301',
      cliHomeDir: targetCliHome,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('invalid-auth auto-reseed does not overwrite manually-authenticated credentials that differ from seed', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-daemon-reseed-manual-guard-'));
  try {
    const storageDir = join(tmp, 'storage');
    const cliDir = join(tmp, 'apps', 'cli');

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await mkdir(join(cliDir, 'dist'), { recursive: true });
    await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export {};\n', 'utf-8');
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');

    const stub = `
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) process.exit(2);

const statePath = join(home, 'daemon.state.json');
const logsDir = join(home, 'logs');
const accessPath = join(home, 'access.key');

if (args[0] !== 'daemon') process.exit(0);
const sub = args[1] || '';

if (sub === 'stop') {
  if (existsSync(statePath)) {
    try {
      const pid = Number(JSON.parse(readFileSync(statePath, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
  }
  process.exit(0);
}

if (sub === 'status') process.exit(0);

if (sub === 'start') {
  mkdirSync(logsDir, { recursive: true });
  const raw = existsSync(accessPath) ? readFileSync(accessPath, 'utf-8') : '';
  let subClaim = '';
  try {
    const token = JSON.parse(raw)?.token ?? '';
    const payloadB64 = String(token).split('.')[1] ?? '';
    const normalized = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
    subClaim = String(payload?.sub ?? '');
  } catch {}
  if (subClaim !== 'manual-user') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    writeFileSync(statePath, JSON.stringify({ pid: child.pid, httpPort: 0 }) + '\\n', 'utf-8');
    process.exit(0);
  }

  const logPath = join(logsDir, \`\${Date.now()}-pid-\${process.pid}-daemon.log\`);
  writeFileSync(
    logPath,
    '[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1 {"message":"Request failed with status code 401","status":401}\\n',
    'utf-8'
  );
  process.exit(1);
}

process.exit(0);
`;
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    await writeFile(cliBin, stub.trimStart(), 'utf-8');

    const targetCliHome = join(storageDir, 'dev', 'cli');
    const seedCliHome = join(storageDir, 'dev-auth', 'cli');
    await mkdir(targetCliHome, { recursive: true });
    await mkdir(seedCliHome, { recursive: true });

    await writeFile(
      join(targetCliHome, 'access.key'),
      credentialFileContents(makeToken({ sub: 'manual-user', nonce: 'manual' })),
      'utf-8'
    );
    await writeFile(
      join(seedCliHome, 'access.key'),
      credentialFileContents(makeToken({ sub: 'seed-user', nonce: 'seed' })),
      'utf-8'
    );
    await writeFile(join(targetCliHome, 'settings.json'), JSON.stringify({ machineId: 'target-machine' }) + '\n', 'utf-8');
    await writeFile(join(seedCliHome, 'settings.json'), JSON.stringify({ machineId: 'seed-machine' }) + '\n', 'utf-8');

    await writeStackEnv({
      storageDir,
      stackName: 'dev',
      env: {
        HAPPIER_STACK_STACK: 'dev',
        HAPPIER_STACK_SERVER_PORT: '4401',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: targetCliHome,
      },
    });
    await writeStackEnv({
      storageDir,
      stackName: 'dev-auth',
      env: {
        HAPPIER_STACK_STACK: 'dev-auth',
        HAPPIER_STACK_SERVER_PORT: '4402',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server',
        HAPPIER_STACK_CLI_HOME_DIR: seedCliHome,
      },
    });

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_AUTH_SEED_FROM: 'dev-auth',
      HAPPIER_STACK_AUTO_AUTH_SEED: '1',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
      HAPPIER_STACK_CLI_BUILD: '0',
    };

    await assert.rejects(
      startLocalDaemonWithAuth({
        cliBin,
        cliHomeDir: targetCliHome,
        internalServerUrl: 'http://127.0.0.1:4401',
        publicServerUrl: 'http://localhost:4401',
        isShuttingDown: () => false,
        forceRestart: true,
        env,
      }),
      /Failed to auto re-seed daemon credentials|Failed to start daemon/
    );

    const targetAccess = await readFile(join(targetCliHome, 'access.key'), 'utf-8');
    assert.equal(
      targetAccess,
      credentialFileContents(makeToken({ sub: 'manual-user', nonce: 'manual' }))
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
