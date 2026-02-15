import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function runHstack(args, { env }) {
  return runNode([join(rootDir, 'bin', 'hstack.mjs'), ...args], { cwd: rootDir, env });
}

function assertExitOk(res, context) {
  assert.equal(res.code, 0, `expected exit 0 for ${context}, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
}

function buildBaseEnv({ homeDir, storageDir, workspaceDir }) {
  return {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
  };
}

function registerDaemonCleanup(t, { env, stackName, identity = '', includeNameFirst = false }) {
  const identityArgs = identity ? [`--identity=${identity}`] : [];
  const commandMatrix = [
    ['stack', 'daemon', stackName, 'stop', ...identityArgs, '--json'],
    ...(includeNameFirst ? [['stack', stackName, 'daemon', 'stop', ...identityArgs, '--json']] : []),
  ];

  t.after(async () => {
    for (const args of commandMatrix) {
      await runHstack(args, { env });
    }
  });
}

async function writeDummyAuth({ cliHomeDir }) {
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
}

async function writeServerScopedAuth({ cliHomeDir, serverUrl }) {
  const paths = resolveStackCredentialPaths({ cliHomeDir, serverUrl });
  await mkdir(dirname(paths.serverScopedPath), { recursive: true });
  await writeFile(paths.serverScopedPath, 'dummy\n', 'utf-8');
  await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
}

async function writeStubHappyCli({ cliDir }) {
  await mkdir(join(cliDir, 'bin'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });

const distScript = `
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
  // Capture resolved target server so integration tests can assert correct stack port selection.
  append('server_url=' + String(process.env.HAPPIER_SERVER_URL || ''));
  append('webapp_url=' + String(process.env.HAPPIER_WEBAPP_URL || ''));
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

  await writeFile(join(cliDir, 'dist', 'index.mjs'), distScript.trimStart(), 'utf-8');
  await writeFile(join(cliDir, 'bin', 'happier.mjs'), "import '../dist/index.mjs';\n", 'utf-8');
}

async function ensureMinimalHappierMonorepo({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

async function createDaemonFixture(t, { prefix, stackName = 'exp-test', serverPort = 4101 } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');

  await ensureMinimalHappierMonorepo({ monoRoot });
  await writeStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli') });

  const stackCliHome = join(storageDir, stackName, 'cli');
  await mkdir(stackCliHome, { recursive: true });

  async function writeStackEnv({ name = stackName, cliHomeDir = stackCliHome, port = serverPort, repoDir = monoRoot } = {}) {
    const envPath = join(storageDir, name, 'env');
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_REPO_DIR=${repoDir}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
        `HAPPIER_STACK_SERVER_PORT=${port}`,
        '',
      ].join('\n'),
      'utf-8'
    );
  }

  return {
    storageDir,
    stackName,
    serverPort,
    stackCliHome,
    baseEnv: buildBaseEnv({ homeDir, storageDir, workspaceDir }),
    writeStackEnv,
  };
}

async function readLogText(logPath) {
  return await readFile(logPath, 'utf-8').then(String);
}

test('hstack stack daemon <name> restart restarts only the daemon', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happier-stack-daemon-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  await writeDummyAuth({ cliHomeDir: fixture.stackCliHome });
  await fixture.writeStackEnv();
  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName, includeNameFirst: true });

  const startRes = await runHstack(['stack', 'daemon', fixture.stackName, 'start', '--json'], { env: fixture.baseEnv });
  assertExitOk(startRes, 'stack daemon start');

  const restartRes = await runHstack(['stack', 'daemon', fixture.stackName, 'restart', '--json'], { env: fixture.baseEnv });
  assertExitOk(restartRes, 'stack daemon restart');

  const logPath = join(fixture.stackCliHome, 'stub-daemon.log');
  const logText = await readLogText(logPath);
  assert.ok(logText.includes('stop'), `expected stub daemon stop to be called\n${logText}`);
  assert.ok(logText.includes('start'), `expected stub daemon start to be called\n${logText}`);
  assert.ok(logText.includes('status'), `expected stub daemon status to be called\n${logText}`);
});

test('hstack stack <name> daemon start works (stack name first)', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-stack-daemon-name-first-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  await writeDummyAuth({ cliHomeDir: fixture.stackCliHome });
  await fixture.writeStackEnv();
  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName, includeNameFirst: true });

  const startRes = await runHstack(['stack', fixture.stackName, 'daemon', 'start', '--json'], { env: fixture.baseEnv });
  assertExitOk(startRes, 'stack <name> daemon start');
  assert.ok(!startRes.stdout.includes('[stack] unknown command'), `unexpected unknown command output\n${startRes.stdout}`);

  const logPath = join(fixture.stackCliHome, 'stub-daemon.log');
  const logText = await readLogText(logPath);
  assert.ok(logText.includes('start'), `expected stub daemon start to be called\n${logText}`);
});

test('hstack stack daemon start accepts server-scoped credentials without legacy access.key', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-stack-daemon-server-scoped-auth-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  await writeServerScopedAuth({ cliHomeDir: fixture.stackCliHome, serverUrl: `http://127.0.0.1:${fixture.serverPort}` });
  await fixture.writeStackEnv();
  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName });

  const startRes = await runHstack(['stack', 'daemon', fixture.stackName, 'start', '--json'], { env: fixture.baseEnv });
  assertExitOk(startRes, 'stack daemon start with server-scoped credentials');
});

test('hstack stack daemon start rejects credentials scoped to a different server url', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-stack-daemon-wrong-server-auth-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  await writeServerScopedAuth({ cliHomeDir: fixture.stackCliHome, serverUrl: 'http://127.0.0.1:4999' });
  await fixture.writeStackEnv();
  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName });

  const startRes = await runHstack(['stack', 'daemon', fixture.stackName, 'start', '--json'], { env: fixture.baseEnv });
  const logPath = join(fixture.stackCliHome, 'stub-daemon.log');
  const logText = existsSync(logPath) ? await readLogText(logPath) : '';

  assert.ok(
    startRes.stdout.includes('"error": "auth_required"') || startRes.stdout.includes('"error":"auth_required"'),
    `expected auth_required response for mismatched server-scoped credentials\nstdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}\nlog:\n${logText}`
  );
  assert.ok(
    !logText.includes('start'),
    `expected daemon start to be blocked for mismatched server-scoped credentials\nstdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}\nlog:\n${logText}`
  );
});

test('hstack stack daemon <name> start/stop with --identity uses an isolated cli home dir', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-stack-daemon-identity-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  const identity = 'account-b';
  const identityHome = join(fixture.storageDir, fixture.stackName, 'cli-identities', identity);
  await writeDummyAuth({ cliHomeDir: identityHome });
  await fixture.writeStackEnv();
  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName, identity });

  const startRes = await runHstack(
    ['stack', 'daemon', fixture.stackName, 'start', `--identity=${identity}`, '--json'],
    { env: fixture.baseEnv }
  );
  assertExitOk(startRes, 'stack daemon start with identity');

  const logPath = join(identityHome, 'stub-daemon.log');
  const logText = await readLogText(logPath);
  assert.ok(logText.includes('start'), `expected stub daemon start to be called in identity home\n${logText}`);

  const stopRes = await runHstack(
    ['stack', 'daemon', fixture.stackName, 'stop', `--identity=${identity}`, '--json'],
    { env: fixture.baseEnv }
  );
  assertExitOk(stopRes, 'stack daemon stop with identity');

  const logTextAfter = await readLogText(logPath);
  assert.ok(logTextAfter.includes('stop'), `expected stub daemon stop to be called for identity\n${logTextAfter}`);
});

test('hstack daemon status targets main stack', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-main-daemon-shortcut-',
    stackName: 'main',
    serverPort: 4101,
  });

  await writeDummyAuth({ cliHomeDir: fixture.stackCliHome });
  await fixture.writeStackEnv();
  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName });

  const startRes = await runHstack(['stack', 'daemon', fixture.stackName, 'start', '--json'], { env: fixture.baseEnv });
  assertExitOk(startRes, 'stack daemon start (main)');

  const statusRes = await runHstack(['daemon', 'status', '--json'], { env: fixture.baseEnv });
  assertExitOk(statusRes, 'daemon status shortcut');

  const logPath = join(fixture.stackCliHome, 'stub-daemon.log');
  const logText = await readLogText(logPath);
  assert.ok(logText.includes('status'), `expected stub daemon status to be called\n${logText}`);
});

test('hstack stack daemon <name> status does not include global process inventory', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-daemon-status-scope-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  await writeDummyAuth({ cliHomeDir: fixture.stackCliHome });
  await fixture.writeStackEnv();
  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName });

  const startRes = await runHstack(['stack', 'daemon', fixture.stackName, 'start', '--json'], { env: fixture.baseEnv });
  assertExitOk(startRes, 'stack daemon start for scoped status');

  const statusRes = await runHstack(['stack', 'daemon', fixture.stackName, 'status', '--json'], { env: fixture.baseEnv });
  assertExitOk(statusRes, 'stack daemon status');

  const parsed = JSON.parse(statusRes.stdout.trim());
  const statusText = String(parsed?.status ?? '');
  assert.equal(
    statusText.includes('🔍 All Happier CLI Processes'),
    false,
    `expected stack-scoped daemon status to omit global process inventory\n${statusText}`
  );
});

test('hstack stack daemon <name> status falls back when cli dist entrypoint is missing', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-daemon-status-fallback-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  await writeDummyAuth({ cliHomeDir: fixture.stackCliHome });
  await fixture.writeStackEnv();
  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName });

  const startRes = await runHstack(['stack', 'daemon', fixture.stackName, 'start', '--json'], { env: fixture.baseEnv });
  assertExitOk(startRes, 'stack daemon start for fallback status');

  const distEntrypoint = join(fixture.baseEnv.HAPPIER_STACK_WORKSPACE_DIR, 'happier', 'apps', 'cli', 'dist', 'index.mjs');
  await rm(distEntrypoint, { force: true });

  const statusRes = await runHstack(['stack', 'daemon', fixture.stackName, 'status', '--json'], { env: fixture.baseEnv });
  assertExitOk(statusRes, 'stack daemon status fallback');

  const parsed = JSON.parse(statusRes.stdout.trim());
  const statusText = String(parsed?.status ?? '');
  assert.ok(
    statusText.includes('Fallback status used because CLI dist entrypoint is missing'),
    `expected fallback marker in daemon status output\n${statusText}`
  );
  assert.ok(
    statusText.includes('Daemon Status'),
    `expected daemon status section in fallback output\n${statusText}`
  );
});

test('hstack stack daemon <name> start uses runtime server port when env port is missing', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-stack-daemon-runtime-port-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  await writeDummyAuth({ cliHomeDir: fixture.stackCliHome });

  // Write a stack env *without* HAPPIER_STACK_SERVER_PORT so the command must fall back to runtime state.
  await fixture.writeStackEnv({ port: '' });

  // Create a runtime state file that indicates the stack server is running on fixture.serverPort.
  const serverStub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      serverStub.kill('SIGTERM');
    } catch {
      // ignore
    }
  });

  const runtimePath = join(fixture.storageDir, fixture.stackName, 'stack.runtime.json');
  await writeFile(
    runtimePath,
    JSON.stringify(
      {
        version: 1,
        stackName: fixture.stackName,
        ephemeral: true,
        ports: { server: fixture.serverPort },
        processes: { serverPid: serverStub.pid },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName });

  const startRes = await runHstack(['stack', 'daemon', fixture.stackName, 'start', '--json'], { env: fixture.baseEnv });
  assertExitOk(startRes, 'stack daemon start uses runtime port');

  const logPath = join(fixture.stackCliHome, 'stub-daemon.log');
  const logText = await readLogText(logPath);
  assert.ok(
    logText.includes(`server_url=http://127.0.0.1:${fixture.serverPort}`),
    `expected daemon env to target runtime port ${fixture.serverPort}\n${logText}`
  );
});

test('hstack stack daemon <name> start uses explicit HAPPIER_SERVER_URL when env port and runtime port are missing', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happy-stacks-stack-daemon-explicit-server-url-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  await writeDummyAuth({ cliHomeDir: fixture.stackCliHome });

  const explicitPort = fixture.serverPort + 9;
  const envPath = join(fixture.storageDir, fixture.stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_REPO_DIR=${fixture.baseEnv.HAPPIER_STACK_WORKSPACE_DIR}/happier`,
      `HAPPIER_STACK_CLI_HOME_DIR=${fixture.stackCliHome}`,
      `HAPPIER_SERVER_URL=http://127.0.0.1:${explicitPort}`,
      `HAPPIER_WEBAPP_URL=http://happier-exp-test.localhost:${explicitPort}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  registerDaemonCleanup(t, { env: fixture.baseEnv, stackName: fixture.stackName });

  const startRes = await runHstack(['stack', 'daemon', fixture.stackName, 'start', '--json'], { env: fixture.baseEnv });
  assertExitOk(startRes, 'stack daemon start uses explicit HAPPIER_SERVER_URL');

  const logPath = join(fixture.stackCliHome, 'stub-daemon.log');
  const logText = await readLogText(logPath);
  assert.ok(
    logText.includes(`server_url=http://127.0.0.1:${explicitPort}`),
    `expected daemon env to target explicit HAPPIER_SERVER_URL port ${explicitPort}\n${logText}`
  );
});

test('hstack stack auth <name> login --identity=<name> --print prints identity-scoped HAPPIER_HOME_DIR', async (t) => {
  const fixture = await createDaemonFixture(t, {
    prefix: 'happier-stack-auth-identity-',
    stackName: 'exp-test',
    serverPort: 4101,
  });

  const identity = 'account-b';
  await writeDummyAuth({ cliHomeDir: fixture.stackCliHome });
  await fixture.writeStackEnv();

  const res = await runHstack(
    [
      'stack',
      'auth',
      fixture.stackName,
      'login',
      `--identity=${identity}`,
      '--no-open',
      '--print',
      '--json',
    ],
    { env: fixture.baseEnv }
  );
  assertExitOk(res, 'stack auth login --identity --print');

  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed?.cliIdentity, identity);
  assert.ok(
    parsed?.cmd?.includes(`HAPPIER_HOME_DIR="${join(fixture.storageDir, fixture.stackName, 'cli-identities', identity)}"`),
    `expected printed cmd to include identity home dir\n${parsed?.cmd}`
  );
  assert.ok(parsed?.cmd?.includes('--no-open'), `expected printed cmd to include --no-open\n${parsed?.cmd}`);
});
