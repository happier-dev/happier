import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

async function ensureMinimalHappierMonorepo({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

async function writeStubHappyCli({ cliDir, message }) {
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(
    join(cliDir, 'dist', 'index.mjs'),
    [
      `console.log(JSON.stringify({`,
      `  message: ${JSON.stringify(message)},`,
      `  stack: process.env.HAPPIER_STACK_STACK || null,`,
      `  envFile: process.env.HAPPIER_STACK_ENV_FILE || null,`,
      `  homeDir: process.env.HAPPIER_HOME_DIR || null,`,
      `  serverUrl: process.env.HAPPIER_SERVER_URL || null,`,
      `  webappUrl: process.env.HAPPIER_WEBAPP_URL || null,`,
      `}));`,
    ].join('\n'),
    'utf-8'
  );
}

async function writeFailingStubHappyCli({ cliDir, errorMessage }) {
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(join(cliDir, 'dist', 'index.mjs'), `console.error(${JSON.stringify(errorMessage)});\nprocess.exit(1);\n`, 'utf-8');
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
  } = {}
) {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const cliDir = join(monoRoot, 'apps', 'cli');
  await ensureMinimalHappierMonorepo({ monoRoot });

  if (stubType === 'failing') {
    await writeFailingStubHappyCli({ cliDir, errorMessage });
  } else {
    await writeStubHappyCli({ cliDir, message });
  }

  const stackCliHome = join(storageDir, stackName, 'cli');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      ...(includePinnedServerPortInEnvFile ? [`HAPPIER_STACK_SERVER_PORT=${serverPort}`] : []),
      '',
    ].join('\n'),
    'utf-8'
  );

  if (runtimeOwnerPid !== null || runtimeServerPid !== null) {
    await writeFile(
      join(storageDir, stackName, 'stack.runtime.json'),
      JSON.stringify(
        {
          version: 1,
          stackName,
          ephemeral: true,
          ownerPid: runtimeOwnerPid,
          ports: { server: serverPort },
          processes: { serverPid: runtimeServerPid },
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
  }

  return {
    stackName,
    storageDir,
    baseEnv: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    },
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

test('hstack stack happier <name> uses stack.runtime.json ports when env file does not pin HAPPIER_STACK_SERVER_PORT', async (t) => {
  const fixture = await createHappyStackFixture(t, {
    prefix: 'happier-stack-stack-happy-runtime-ports-',
    message: 'runtime-ports',
    serverPort: 4777,
    includePinnedServerPortInEnvFile: false,
    // Simulate a stale owner pid but a still-running server process.
    runtimeOwnerPid: 999999,
    runtimeServerPid: process.pid,
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

test('hstack stack happier <name> does not print wrapper stack traces on CLI failure', async (t) => {
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
  assert.ok(!res.stderr.includes('[happier] failed:'), `expected no [happier] failed stack trace, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('[stack] failed:'), `expected no [stack] failed stack trace, got:\n${res.stderr}`);
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
