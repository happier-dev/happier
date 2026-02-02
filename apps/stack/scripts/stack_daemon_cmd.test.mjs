import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function writeDummyAuth({ cliHomeDir }) {
  // For these tests, we don't care about the auth format—only that credentials exist.
  // hstack will short-circuit daemon start when access.key is missing.
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
}

async function writeStubHappyCli({ cliDir }) {
  await mkdir(join(cliDir, 'bin'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });

  // startLocalDaemonWithAuth() checks for dist/index.mjs existence.
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export {};\n', 'utf-8');

  const script = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) {
  console.error('missing HAPPIER_HOME_DIR');
  process.exit(2);
}
const log = join(home, 'stub-daemon.log');
const state = join(home, 'daemon.state.json');

function append(line) {
  try { writeFileSync(log, line + '\\n', { flag: 'a' }); } catch {}
}

if (args[0] !== 'daemon') {
  append('unknown:' + args.join(' '));
  process.exit(0);
}

const sub = args[1] || '';
if (sub === 'stop') {
  append('stop');
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { rmSync(state); } catch {}
  }
  process.exit(0);
}

if (sub === 'start') {
  append('start');
  // Spawn a long-lived process and record its pid so "status" can observe it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(state, JSON.stringify({ pid: child.pid, httpPort: 0, startTime: new Date().toISOString() }) + '\\n', 'utf-8');
  process.exit(0);
}

if (sub === 'status') {
  append('status');
  let ok = false;
  if (existsSync(state)) {
    try {
      const pid = Number(JSON.parse(readFileSync(state, 'utf-8')).pid);
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 0); ok = true; } catch {}
      }
    } catch {}
  }
  console.log(ok ? 'daemon: running' : 'daemon: stopped');
  process.exit(0);
}

append('other:' + sub);
process.exit(0);
`;

  await writeFile(join(cliDir, 'bin', 'happier.mjs'), script.trimStart(), 'utf-8');
  return cliDir;
}

async function ensureMinimalHappierMonorepo({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

test('hstack stack daemon <name> restart restarts only the daemon', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-daemon-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackName = 'exp-test';

  await ensureMinimalHappierMonorepo({ monoRoot });
  const cliDir = await writeStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli') });
  const stackCliHome = join(storageDir, stackName, 'cli');
  await mkdir(stackCliHome, { recursive: true });
  await writeDummyAuth({ cliHomeDir: stackCliHome });

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
      envPath,
      [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=4101`,
      '',
      ].join('\n'),
      'utf-8'
    );

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
  };

  // Start daemon once.
  const startRes = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', stackName, 'start', '--json'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(
    startRes.code,
    0,
    `expected start exit 0, got ${startRes.code}\nstdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`
  );

  // Restart daemon (should run stop+start+status via our helper).
  const restartRes = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', stackName, 'restart', '--json'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(
    restartRes.code,
    0,
    `expected restart exit 0, got ${restartRes.code}\nstdout:\n${restartRes.stdout}\nstderr:\n${restartRes.stderr}`
  );

  const logPath = join(stackCliHome, 'stub-daemon.log');
  const log = (await import('node:fs/promises')).readFile(logPath, 'utf-8').then(String);
  const logText = await log;
  assert.ok(logText.includes('stop'), `expected stub daemon stop to be called\n${logText}`);
  assert.ok(logText.includes('start'), `expected stub daemon start to be called\n${logText}`);
  assert.ok(logText.includes('status'), `expected stub daemon status to be called\n${logText}`);

  // Cleanup: stop the spawned background daemon process (best-effort via our stub).
  await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', stackName, 'stop', '--json'], { cwd: rootDir, env: baseEnv });
  await rm(tmp, { recursive: true, force: true });
});

test('hstack stack <name> daemon start works (stack name first)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-daemon-name-first-'));
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackName = 'exp-test';

  await ensureMinimalHappierMonorepo({ monoRoot });
  const cliDir = await writeStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli') });
  const stackCliHome = join(storageDir, stackName, 'cli');
  await mkdir(stackCliHome, { recursive: true });
  await writeDummyAuth({ cliHomeDir: stackCliHome });

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
      envPath,
      [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=4101`,
      '',
      ].join('\n'),
      'utf-8'
    );

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
  };

  const startRes = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', stackName, 'daemon', 'start', '--json'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(
    startRes.code,
    0,
    `expected start exit 0, got ${startRes.code}\nstdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`
  );
  assert.ok(!startRes.stdout.includes('[stack] unknown command'), `unexpected unknown command output\n${startRes.stdout}`);

  const logPath = join(stackCliHome, 'stub-daemon.log');
  const logText = await (await import('node:fs/promises')).readFile(logPath, 'utf-8').then(String);
  assert.ok(logText.includes('start'), `expected stub daemon start to be called\n${logText}`);

  await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', stackName, 'daemon', 'stop', '--json'], { cwd: rootDir, env: baseEnv });
  await rm(tmp, { recursive: true, force: true });
});

test('hstack stack daemon <name> start/stop with --identity uses an isolated cli home dir', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-daemon-identity-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackName = 'exp-test';
  const identity = 'account-b';
  await ensureMinimalHappierMonorepo({ monoRoot });
  const cliDir = await writeStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli') });
  const stackCliHome = join(storageDir, stackName, 'cli');
  await mkdir(stackCliHome, { recursive: true });
  const identityHome = join(storageDir, stackName, 'cli-identities', identity);
  await writeDummyAuth({ cliHomeDir: identityHome });

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
      envPath,
      [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=4101`,
      '',
      ].join('\n'),
      'utf-8'
    );

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
  };

  const startRes = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', stackName, 'start', `--identity=${identity}`, '--json'],
    { cwd: rootDir, env: baseEnv }
  );
  assert.equal(
    startRes.code,
    0,
    `expected start exit 0, got ${startRes.code}\nstdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`
  );

  const logPath = join(identityHome, 'stub-daemon.log');
  const logText = await (await import('node:fs/promises')).readFile(logPath, 'utf-8').then(String);
  assert.ok(logText.includes('start'), `expected stub daemon start to be called in identity home\n${logText}`);

  const stopRes = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', stackName, 'stop', `--identity=${identity}`, '--json'],
    { cwd: rootDir, env: baseEnv }
  );
  assert.equal(
    stopRes.code,
    0,
    `expected stop exit 0, got ${stopRes.code}\nstdout:\n${stopRes.stdout}\nstderr:\n${stopRes.stderr}`
  );

  const logTextAfter = await (await import('node:fs/promises')).readFile(logPath, 'utf-8').then(String);
  assert.ok(logTextAfter.includes('stop'), `expected stub daemon stop to be called for identity\n${logTextAfter}`);

  await rm(tmp, { recursive: true, force: true });
});

test('hstack stack auth <name> login --identity=<name> --print prints identity-scoped HAPPIER_HOME_DIR', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-auth-identity-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackName = 'exp-test';
  const identity = 'account-b';

  await ensureMinimalHappierMonorepo({ monoRoot });
  const cliDir = await writeStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli') });
  const stackCliHome = join(storageDir, stackName, 'cli');
  await mkdir(stackCliHome, { recursive: true });
  await writeDummyAuth({ cliHomeDir: stackCliHome });

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
      envPath,
      [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=4101`,
      '',
      ].join('\n'),
      'utf-8'
    );

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
  };

  const res = await runNode(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'auth',
      stackName,
      'login',
      `--identity=${identity}`,
      '--no-open',
      '--print',
      '--json',
    ],
    { cwd: rootDir, env: baseEnv }
  );
  assert.equal(
    res.code,
    0,
    `expected auth login --print exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );

  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed?.cliIdentity, identity);
  assert.ok(
    parsed?.cmd?.includes(`HAPPIER_HOME_DIR="${join(storageDir, stackName, 'cli-identities', identity)}"`),
    `expected printed cmd to include identity home dir\n${parsed?.cmd}`
  );
  assert.ok(
    parsed?.cmd?.includes('--no-open'),
    `expected printed cmd to include --no-open\n${parsed?.cmd}`
  );

  await rm(tmp, { recursive: true, force: true });
});
