import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';
import { killDetachedProcessGroup } from './testkit/core/spawn_daemon_like_process.mjs';
import { createStackHappierCliCommandFixture } from './testkit/stack_happier_cli_command_testkit.mjs';
import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

function buildStubHappyCliScript({ message }) {
  return [
      `console.log(JSON.stringify({`,
      `  message: ${JSON.stringify(message)},`,
      `  args: process.argv.slice(2),`,
      `  stack: process.env.HAPPIER_STACK_STACK || null,`,
      `  envFile: process.env.HAPPIER_STACK_ENV_FILE || null,`,
      `  homeDir: process.env.HAPPIER_HOME_DIR || null,`,
      `  serverUrl: process.env.HAPPIER_SERVER_URL || null,`,
      `  webappUrl: process.env.HAPPIER_WEBAPP_URL || null,`,
      `  activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID || null,`,
      `}));`,
    ].join('\n');
}

function buildFailingStubHappyCliScript({ errorMessage }) {
  return `console.error(${JSON.stringify(errorMessage)});\nprocess.exit(1);\n`;
}

async function createHappyStackFixture(
  t,
  {
    prefix,
    stackName = 'exp-test',
    serverPort = 3999,
    stubType = 'success',
    message = 'hello',
    errorMessage = 'stub failure',
    includePinnedServerPortInEnvFile = true,
    runtimeOwnerPid = null,
    runtimeServerPid = null,
    stackCliSettings = null,
  } = {}
) {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix,
    stackName,
    serverPort,
    distIndexScript:
      stubType === 'failing'
        ? buildFailingStubHappyCliScript({ errorMessage })
        : buildStubHappyCliScript({ message }),
  });
  if (!includePinnedServerPortInEnvFile) {
    await fixture.writeStackEnv({ port: '' });
  }

  let runtimeServerPidValue = runtimeServerPid;
  if (runtimeServerPid === 'stack-owned') {
    const runtimeServer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: fixture.envPath,
        HAPPIER_STACK_CLI_HOME_DIR: fixture.stackCliHome,
      },
    });
    t.after(() => {
      try {
        runtimeServer.kill('SIGKILL');
      } catch {
        // ignore
      }
    });
    runtimeServerPidValue = runtimeServer.pid;
  }

  if (stackCliSettings) {
    await mkdir(join(fixture.storageDir, stackName, 'cli'), { recursive: true });
    await writeFile(
      join(fixture.storageDir, stackName, 'cli', 'settings.json'),
      JSON.stringify(stackCliSettings, null, 2) + '\n',
      'utf-8',
    );
  }

  if (runtimeOwnerPid !== null || runtimeServerPid !== null) {
    await writeFile(
      join(fixture.storageDir, stackName, 'stack.runtime.json'),
      JSON.stringify(
        {
          version: 1,
          stackName,
          ephemeral: true,
          ownerPid: runtimeOwnerPid,
          ports: { server: serverPort },
          processes: { serverPid: runtimeServerPidValue },
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
  }

  return {
    stackName: fixture.stackName,
    storageDir: fixture.storageDir,
    baseEnv: fixture.baseEnv,
  };
}

test('hstack stack happier <name> runs CLI under that stack env', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-',
    message: 'hello',
    serverPort: 3999,
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'hello');
  assert.equal(out.stack, fixture.stackName);
  assert.ok(String(out.envFile).endsWith(`/${fixture.stackName}/env`), `expected envFile to end with /${fixture.stackName}/env, got: ${out.envFile}`);
  assert.equal(out.homeDir, join(fixture.storageDir, fixture.stackName, 'cli'));
  assert.equal(out.serverUrl, 'http://127.0.0.1:3999');
});

test('hstack stack happier <name> overrides pre-set HAPPIER_* env vars with stack-scoped values', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-override-',
    message: 'override',
    serverPort: 4123,
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName], {
    cwd: rootDir,
    env: {
      ...fixture.baseEnv,
      HAPPIER_HOME_DIR: join(fixture.storageDir, 'wrong', 'cli'),
      HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
      HAPPIER_WEBAPP_URL: 'http://wrong-webapp.example.test',
    },
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'override');
  assert.equal(out.stack, fixture.stackName);
  assert.equal(out.homeDir, join(fixture.storageDir, fixture.stackName, 'cli'));
  assert.equal(out.serverUrl, 'http://127.0.0.1:4123');
});

test('hstack stack happier <name> ignores stale cloud settings defaults and keeps stack-local server urls', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-ignore-settings-',
    message: 'ignore-settings-defaults',
    serverPort: 44123,
    stackCliSettings: {
      schemaVersion: 6,
      onboardingCompleted: false,
      activeServerId: 'cloud',
      servers: {
        cloud: {
          id: 'cloud',
          name: 'Happier Cloud',
          serverUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: 0,
        },
      },
    },
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'ignore-settings-defaults');
  assert.equal(out.stack, fixture.stackName);
  assert.equal(out.homeDir, join(fixture.storageDir, fixture.stackName, 'cli'));
  assert.equal(out.serverUrl, 'http://127.0.0.1:44123');
  assert.equal(out.webappUrl, 'http://localhost:44123');
});

test('hstack stack happier <name> seeds stack server profile in CLI settings for env-hardened subcommands', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-seed-settings-',
    message: 'seed-settings',
    serverPort: 45123,
    stackCliSettings: {
      schemaVersion: 6,
      onboardingCompleted: false,
      activeServerId: 'cloud',
      servers: {
        cloud: {
          id: 'cloud',
          name: 'Happier Cloud',
          serverUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: 0,
        },
      },
    },
  });

  const settingsPath = join(fixture.storageDir, fixture.stackName, 'cli', 'settings.json');

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'seed-settings');
  assert.ok(out.activeServerId, 'expected wrapper to export HAPPIER_ACTIVE_SERVER_ID');

  const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
  assert.equal(settings.schemaVersion, 6);
  assert.equal(settings.activeServerId, out.activeServerId);
  assert.ok(settings.servers?.[out.activeServerId], `expected settings.servers[${out.activeServerId}] to exist`);
  assert.equal(settings.servers[out.activeServerId].serverUrl, 'http://127.0.0.1:45123');
  assert.equal(settings.servers[out.activeServerId].webappUrl, 'http://localhost:45123');
});

test('hstack stack happier <name> reuses an equivalent loopback profile id when seeding stack settings', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-seed-loopback-',
    message: 'seed-loopback',
    serverPort: 45124,
    stackCliSettings: {
      schemaVersion: 6,
      onboardingCompleted: true,
      activeServerId: 'stack-local',
      servers: {
        'stack-local': {
          id: 'stack-local',
          name: 'Stack local',
          serverUrl: 'http://localhost:45124',
          localServerUrl: 'http://127.0.0.1:45124',
          webappUrl: 'http://localhost:45124',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      },
    },
  });

  const settingsPath = join(fixture.storageDir, fixture.stackName, 'cli', 'settings.json');
  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
  assert.equal(out.activeServerId, 'stack-local');
  assert.equal(settings.activeServerId, 'stack-local');
  assert.equal(Object.keys(settings.servers).filter((id) => id === 'stack-local').length, 1);
});

test('hstack stack happier <name> uses stack.runtime.json ports when env file does not pin HAPPIER_STACK_SERVER_PORT', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-runtime-ports-',
    message: 'runtime-ports',
    serverPort: 4777,
    includePinnedServerPortInEnvFile: false,
    // Simulate a stale owner pid but a still-running server process.
    runtimeOwnerPid: 999999,
    runtimeServerPid: 'stack-owned',
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'runtime-ports');
  assert.equal(out.stack, fixture.stackName);
  assert.equal(out.serverUrl, 'http://127.0.0.1:4777');
});

test('hstack stack happier <name> session create preflights the stack daemon before invoking the CLI command', async (t) => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'happier-stack-stack-happy-daemon-preflight-',
    stackName: 'exp-test',
    serverPort: 4999,
    distIndexScript: `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killDetachedProcessGroup, spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) {
  console.error('missing HAPPIER_HOME_DIR');
  process.exit(2);
}

const stateDir = join(home, 'servers', 'stack_exp-test__id_default');
const statePath = join(stateDir, 'daemon.state.json');
const logPath = join(home, 'passthrough-daemon.log');
const append = (line) => writeFileSync(logPath, line + '\\n', { flag: 'a' });

if (args[0] === 'daemon' && args[1] === 'start') {
  spawnDaemonLikeProcess({
    cliHomeDir: home,
    internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
    publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
    statePaths: [statePath],
  });
  append('daemon-start');
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'stop') {
  append('daemon-stop');
  if (existsSync(statePath)) {
    try {
      const pid = Number(JSON.parse(readFileSync(statePath, 'utf-8')).pid);
      killDetachedProcessGroup(pid);
    } catch {}
  }
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'status') {
  append('daemon-status');
  process.exit(0);
}

if (args[0] === 'session' && args[1] === 'create') {
  append('session-create');
  if (!existsSync(statePath)) {
    console.error(JSON.stringify({ ok: false, error: 'No daemon running, no state file found' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, sessionId: 'session-preflight-ok', state: JSON.parse(readFileSync(statePath, 'utf-8')) }));
  process.exit(0);
}

console.log(JSON.stringify({ ok: true, args }));
`,
  });

  await mkdir(fixture.stackCliHome, { recursive: true });
  await writeFile(join(fixture.stackCliHome, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(fixture.stackCliHome, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
  const statePath = join(fixture.stackCliHome, 'servers', 'stack_exp-test__id_default', 'daemon.state.json');
  t.after(async () => {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      killDetachedProcessGroup(Number(state?.pid));
    } catch {
      // ignore cleanup failures when the daemon never started
    }
  });

  const res = await runNodeCapture(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName, 'session', 'create', '--json'],
    {
      cwd: rootDir,
      env: fixture.baseEnv,
    },
  );

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim().split('\n').filter(Boolean).at(-1));
  assert.equal(out.ok, true);
  assert.equal(out.sessionId, 'session-preflight-ok');

  const logText = await readFile(join(fixture.stackCliHome, 'passthrough-daemon.log'), 'utf-8');
  assert.match(logText, /daemon-start/);
  assert.match(logText, /session-create/);
});

test('hstack stack happier <name> forwards wrapper runtime flags to happier.mjs', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, {
    stackName: 'runtime-wrapper-passthrough',
    cliEntrypoint: 'cli/happier.mjs',
    cliSource: 'process.stdout.write("SNAPSHOT WRAPPER HELP\\n");\n',
  });

  const res = await runNodeCapture(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName, '--runtime', '--', '--help'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_REPO_DIR: fixture.root,
      },
    },
  );

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /SNAPSHOT WRAPPER HELP/);
});

test('hstack happier (HAPPIER_STACK_STACK set) uses stack.runtime.json ports when env file does not pin HAPPIER_STACK_SERVER_PORT', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-happy-runtime-ports-',
    message: 'runtime-ports-env',
    serverPort: 4888,
    includePinnedServerPortInEnvFile: false,
    // Simulate a stale owner pid but a still-running server process.
    runtimeOwnerPid: 999999,
    runtimeServerPid: 'stack-owned',
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'happier.mjs')], {
    cwd: rootDir,
    env: {
      ...fixture.baseEnv,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: join(fixture.storageDir, fixture.stackName, 'env'),
    },
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'runtime-ports-env');
  assert.equal(out.stack, fixture.stackName);
  assert.equal(out.serverUrl, 'http://127.0.0.1:4888');
  assert.equal(out.webappUrl, 'http://localhost:4888');
});

test('hstack happier (HAPPIER_STACK_STACK set) session create preflights the stack daemon before invoking the CLI command', async (t) => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'happier-stack-happy-daemon-preflight-env-',
    stackName: 'exp-test',
    serverPort: 4899,
    distIndexScript: `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killDetachedProcessGroup, spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts', 'testkit', 'core', 'spawn_daemon_like_process.mjs'))};

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) {
  console.error('missing HAPPIER_HOME_DIR');
  process.exit(2);
}

const stateDir = join(home, 'servers', 'stack_exp-test__id_default');
const statePath = join(stateDir, 'daemon.state.json');
const logPath = join(home, 'passthrough-daemon-env.log');
const append = (line) => writeFileSync(logPath, line + '\\n', { flag: 'a' });

if (args[0] === 'daemon' && args[1] === 'start') {
  spawnDaemonLikeProcess({
    cliHomeDir: home,
    internalServerUrl: String(process.env.HAPPIER_SERVER_URL || ''),
    publicServerUrl: String(process.env.HAPPIER_WEBAPP_URL || ''),
    statePaths: [statePath],
  });
  append('daemon-start');
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'stop') {
  append('daemon-stop');
  if (existsSync(statePath)) {
    try {
      const pid = Number(JSON.parse(readFileSync(statePath, 'utf-8')).pid);
      killDetachedProcessGroup(pid);
    } catch {}
  }
  process.exit(0);
}

if (args[0] === 'daemon' && args[1] === 'status') {
  append('daemon-status');
  process.exit(0);
}

if (args[0] === 'session' && args[1] === 'create') {
  append('session-create');
  if (!existsSync(statePath)) {
    console.error(JSON.stringify({ ok: false, error: 'No daemon running, no state file found' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, sessionId: 'session-preflight-env-ok', state: JSON.parse(readFileSync(statePath, 'utf-8')) }));
  process.exit(0);
}

console.log(JSON.stringify({ ok: true, args }));
`,
  });

  await mkdir(fixture.stackCliHome, { recursive: true });
  await writeFile(join(fixture.stackCliHome, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(fixture.stackCliHome, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');
  const statePath = join(fixture.stackCliHome, 'servers', 'stack_exp-test__id_default', 'daemon.state.json');
  t.after(async () => {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      killDetachedProcessGroup(Number(state?.pid));
    } catch {
      // ignore cleanup failures when the daemon never started
    }
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'happier', 'session', 'create', '--json'], {
    cwd: rootDir,
    env: {
      ...fixture.baseEnv,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: join(fixture.storageDir, fixture.stackName, 'env'),
    },
  });

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim().split('\n').filter(Boolean).at(-1));
  assert.equal(out.ok, true);
  assert.equal(out.sessionId, 'session-preflight-env-ok');

  const logText = await readFile(join(fixture.stackCliHome, 'passthrough-daemon-env.log'), 'utf-8');
  assert.match(logText, /daemon-start/);
  assert.match(logText, /session-create/);
});

test('hstack happier (HAPPIER_STACK_STACK set) session create --help skips stack daemon preflight', async (t) => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'happier-stack-happy-daemon-help-env-',
    stackName: 'exp-test',
    serverPort: 4901,
    distIndexScript: `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
if (!home) {
  console.error('missing HAPPIER_HOME_DIR');
  process.exit(2);
}

const stateDir = join(home, 'servers', 'stack_exp-test__id_default');
const statePath = join(stateDir, 'daemon.state.json');
const logPath = join(home, 'passthrough-daemon-help-env.log');
const append = (line) => writeFileSync(logPath, line + '\\n', { flag: 'a' });

if (args[0] === 'daemon' && args[1] === 'start') {
  append('daemon-start');
  process.exit(0);
}

if (args[0] === 'session' && args[1] === 'create' && (args.includes('--help') || args.includes('-h'))) {
  append('session-create-help');
  if (existsSync(statePath)) {
    append('unexpected-daemon-state');
  }
  console.log('SESSION CREATE HELP');
  process.exit(0);
}

console.log(JSON.stringify({ ok: true, args }));
`,
  });

  await mkdir(fixture.stackCliHome, { recursive: true });
  await writeFile(join(fixture.stackCliHome, 'access.key'), 'dummy\n', 'utf-8');
  await writeFile(join(fixture.stackCliHome, 'settings.json'), JSON.stringify({ machineId: 'test-machine' }) + '\n', 'utf-8');

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'happier', 'session', 'create', '--help'], {
    cwd: rootDir,
    env: {
      ...fixture.baseEnv,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: join(fixture.storageDir, fixture.stackName, 'env'),
    },
  });

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /SESSION CREATE HELP/);

  const logPath = join(fixture.stackCliHome, 'passthrough-daemon-help-env.log');
  const logText = existsSync(logPath) ? await readFile(logPath, 'utf-8') : '';
  assert.match(logText, /session-create-help/);
  assert.doesNotMatch(logText, /daemon-start/);
  assert.doesNotMatch(logText, /unexpected-daemon-state/);
});

test('hstack happier prefers the matching stack server profile id over the stable scope id', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-explicit-stack-scope-',
    message: 'explicit-stack-scope',
    serverPort: 5123,
    stackCliSettings: {
      schemaVersion: 6,
      onboardingCompleted: true,
      activeServerId: 'stack-local',
      servers: {
        'stack-local': {
          id: 'stack-local',
          name: 'Stack Local',
          serverUrl: 'http://127.0.0.1:5123',
          webappUrl: 'http://localhost:5123',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: 0,
        },
      },
    },
  });

  const env = {
    ...fixture.baseEnv,
    HAPPIER_STACK_STACK: fixture.stackName,
  };
  delete env.HAPPIER_STACK_ENV_FILE;

  const res = await runNodeCapture([join(rootDir, 'bin', 'happier.mjs')], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'explicit-stack-scope');
  assert.equal(out.stack, fixture.stackName);
  assert.ok(String(out.envFile).endsWith(`/${fixture.stackName}/env`), `expected envFile to end with /${fixture.stackName}/env, got: ${out.envFile}`);
  assert.equal(out.homeDir, join(fixture.storageDir, fixture.stackName, 'cli'));
  assert.equal(out.serverUrl, 'http://127.0.0.1:5123');
  assert.equal(out.webappUrl, 'http://localhost:5123');
  assert.equal(out.activeServerId, 'stack-local');
});

test('hstack stack happier <name> --identity=<name> uses identity-scoped HAPPIER_HOME_DIR', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-identity-',
    message: 'identity',
    serverPort: 3999,
  });
  const identity = 'account-a';

  const res = await runNodeCapture(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName, `--identity=${identity}`],
    { cwd: rootDir, env: fixture.baseEnv }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'identity');
  assert.equal(out.stack, fixture.stackName);
  assert.equal(out.homeDir, join(fixture.storageDir, fixture.stackName, 'cli-identities', identity));
  assert.equal(out.serverUrl, 'http://127.0.0.1:3999');
});

test('hstack <stack> happier ... shorthand runs CLI under that stack env', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happy-stacks-stack-happy-',
    message: 'shorthand',
    serverPort: 4101,
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), fixture.stackName, 'happier'], { cwd: rootDir, env: fixture.baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'shorthand');
  assert.equal(out.stack, fixture.stackName);
  assert.equal(out.serverUrl, 'http://127.0.0.1:4101');
});

test('hstack stack happier <name> surfaces concise wrapper failure without node internals when daemon preflight fails', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happy-stacks-stack-happy-fail-',
    stubType: 'failing',
    errorMessage: 'stub failure',
    serverPort: 3999,
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName, 'attach', 'abc'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stderr.includes('stub failure'), `expected stderr to include stub failure, got:\n${res.stderr}`);
  assert.ok(res.stderr.includes('[stack] failed: Failed to start daemon'), `expected concise wrapper failure, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('[happier] failed:'), `expected no [happier] failed stack trace, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('node:internal'), `expected no node:internal stack trace, got:\n${res.stderr}`);
});

test('hstack stack <name> happier ... stack-name-first shorthand works', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-name-first-',
    message: 'name-first',
    serverPort: 3999,
  });

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'stack', fixture.stackName, 'happier'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'name-first');
  assert.equal(out.stack, fixture.stackName);
});

test('hstack stack bug-report <name> forwards bug-report command under stack env', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-bug-report-',
    message: 'bug-report-alias',
    serverPort: 4099,
  });

  const res = await runNodeCapture(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'bug-report',
      fixture.stackName,
      '--',
      '--title',
      'CLI bug',
      '--summary',
      'summary',
      '--current-behavior',
      'current',
      '--expected-behavior',
      'expected',
      '--accept-privacy-notice',
      '--no-include-diagnostics',
    ],
    { cwd: rootDir, env: fixture.baseEnv }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'bug-report-alias');
  assert.equal(out.stack, fixture.stackName);
  assert.equal(out.args[0], 'bug-report');
});
