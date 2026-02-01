import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
      `  homeDir: process.env.HAPPY_HOME_DIR || null,`,
      `  serverUrl: process.env.HAPPY_SERVER_URL || null,`,
      `  webappUrl: process.env.HAPPY_WEBAPP_URL || null,`,
      `}));`,
    ].join('\n'),
    'utf-8'
  );
  return cliDir;
}

async function writeFailingStubHappyCli({ cliDir, errorMessage }) {
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(
    join(cliDir, 'dist', 'index.mjs'),
    [
      `console.error(${JSON.stringify(errorMessage)});`,
      `process.exit(1);`,
      '',
    ].join('\n'),
    'utf-8'
  );
  return cliDir;
}

test('hstack stack happy <name> runs happy-cli under that stack env', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-happy-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackName = 'exp-test';

  await ensureMinimalHappierMonorepo({ monoRoot });
  const cliDir = await writeStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli'), message: 'hello' });

  const stackCliHome = join(storageDir, stackName, 'cli');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=3999`,
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

  const res = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happy', stackName], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'hello');
  assert.equal(out.stack, stackName);
  assert.ok(String(out.envFile).endsWith(`/${stackName}/env`), `expected envFile to end with /${stackName}/env, got: ${out.envFile}`);
  assert.equal(out.homeDir, stackCliHome);
  assert.equal(out.serverUrl, 'http://127.0.0.1:3999');
});

test('hstack stack happy <name> --identity=<name> uses identity-scoped HAPPY_HOME_DIR', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-happy-identity-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackName = 'exp-test';
  const identity = 'account-a';

  await ensureMinimalHappierMonorepo({ monoRoot });
  const cliDir = await writeStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli'), message: 'identity' });

  const stackCliHome = join(storageDir, stackName, 'cli');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=3999`,
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
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happy', stackName, `--identity=${identity}`],
    { cwd: rootDir, env: baseEnv }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'identity');
  assert.equal(out.stack, stackName);
  assert.equal(out.homeDir, join(storageDir, stackName, 'cli-identities', identity));
  assert.equal(out.serverUrl, 'http://127.0.0.1:3999');
});

test('hstack <stack> happy ... shorthand runs happy-cli under that stack env', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-happy-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackName = 'exp-test';

  await ensureMinimalHappierMonorepo({ monoRoot });
  const cliDir = await writeStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli'), message: 'shorthand' });

  const stackCliHome = join(storageDir, stackName, 'cli');
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

  const res = await runNode([join(rootDir, 'bin', 'hstack.mjs'), stackName, 'happy'], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'shorthand');
  assert.equal(out.stack, stackName);
  assert.equal(out.serverUrl, 'http://127.0.0.1:4101');
});

test('hstack stack happy <name> does not print wrapper stack traces on happy-cli failure', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-happy-fail-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackName = 'exp-test';

  await ensureMinimalHappierMonorepo({ monoRoot });
  const cliDir = await writeFailingStubHappyCli({ cliDir: join(monoRoot, 'apps', 'cli'), errorMessage: 'stub failure' });

  const stackCliHome = join(storageDir, stackName, 'cli');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPIER_STACK_SERVER_PORT=3999`,
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
  const res = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'happy', stackName, 'attach', 'abc'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stderr.includes('stub failure'), `expected stderr to include stub failure, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('[happy] failed:'), `expected no [happy] failed stack trace, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('[stack] failed:'), `expected no [stack] failed stack trace, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('node:internal'), `expected no node:internal stack trace, got:\n${res.stderr}`);
});
