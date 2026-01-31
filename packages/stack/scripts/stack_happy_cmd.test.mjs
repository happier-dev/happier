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

async function writeStubHappyCli({ root, message }) {
  const cliDir = join(root, 'happy-cli');
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(
    join(cliDir, 'dist', 'index.mjs'),
    [
      `console.log(JSON.stringify({`,
      `  message: ${JSON.stringify(message)},`,
      `  stack: process.env.HAPPY_STACKS_STACK || process.env.HAPPY_LOCAL_STACK || null,`,
      `  envFile: process.env.HAPPY_STACKS_ENV_FILE || process.env.HAPPY_LOCAL_ENV_FILE || null,`,
      `  homeDir: process.env.HAPPY_HOME_DIR || null,`,
      `  serverUrl: process.env.HAPPY_SERVER_URL || null,`,
      `  webappUrl: process.env.HAPPY_WEBAPP_URL || null,`,
      `}));`,
    ].join('\n'),
    'utf-8'
  );
  return cliDir;
}

async function writeFailingStubHappyCli({ root, errorMessage }) {
  const cliDir = join(root, 'happy-cli');
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

test('happys stack happy <name> runs happy-cli under that stack env', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-happy-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';

  const stubRoot = join(tmp, 'stub-components');
  const cliDir = await writeStubHappyCli({ root: stubRoot, message: 'hello' });

  const stackCliHome = join(storageDir, stackName, 'cli');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI=${cliDir}`,
      `HAPPY_STACKS_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPY_STACKS_SERVER_PORT=3999`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_CLI_ROOT_DISABLE: '1',
  };

  const res = await runNode([join(rootDir, 'bin', 'happys.mjs'), 'stack', 'happy', stackName], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'hello');
  assert.equal(out.stack, stackName);
  assert.ok(String(out.envFile).endsWith(`/${stackName}/env`), `expected envFile to end with /${stackName}/env, got: ${out.envFile}`);
  assert.equal(out.homeDir, stackCliHome);
  assert.equal(out.serverUrl, 'http://127.0.0.1:3999');
});

test('happys stack happy <name> --identity=<name> uses identity-scoped HAPPY_HOME_DIR', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-happy-identity-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';
  const identity = 'account-a';

  const stubRoot = join(tmp, 'stub-components');
  const cliDir = await writeStubHappyCli({ root: stubRoot, message: 'identity' });

  const stackCliHome = join(storageDir, stackName, 'cli');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI=${cliDir}`,
      `HAPPY_STACKS_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPY_STACKS_SERVER_PORT=3999`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_CLI_ROOT_DISABLE: '1',
  };

  const res = await runNode(
    [join(rootDir, 'bin', 'happys.mjs'), 'stack', 'happy', stackName, `--identity=${identity}`],
    { cwd: rootDir, env: baseEnv }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'identity');
  assert.equal(out.stack, stackName);
  assert.equal(out.homeDir, join(storageDir, stackName, 'cli-identities', identity));
  assert.equal(out.serverUrl, 'http://127.0.0.1:3999');
});

test('happys <stack> happy ... shorthand runs happy-cli under that stack env', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-happy-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';

  const stubRoot = join(tmp, 'stub-components');
  const cliDir = await writeStubHappyCli({ root: stubRoot, message: 'shorthand' });

  const stackCliHome = join(storageDir, stackName, 'cli');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI=${cliDir}`,
      `HAPPY_STACKS_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPY_STACKS_SERVER_PORT=4101`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_CLI_ROOT_DISABLE: '1',
  };

  const res = await runNode([join(rootDir, 'bin', 'happys.mjs'), stackName, 'happy'], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.message, 'shorthand');
  assert.equal(out.stack, stackName);
  assert.equal(out.serverUrl, 'http://127.0.0.1:4101');
});

test('happys stack happy <name> does not print wrapper stack traces on happy-cli failure', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-happy-fail-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';  const stubRoot = join(tmp, 'stub-components');
  const cliDir = await writeFailingStubHappyCli({ root: stubRoot, errorMessage: 'stub failure' });

  const stackCliHome = join(storageDir, stackName, 'cli');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI=${cliDir}`,
      `HAPPY_STACKS_CLI_HOME_DIR=${stackCliHome}`,
      `HAPPY_STACKS_SERVER_PORT=3999`,
      '',
    ].join('\n'),
    'utf-8'
  );  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_CLI_ROOT_DISABLE: '1',
  };  const res = await runNode([join(rootDir, 'bin', 'happys.mjs'), 'stack', 'happy', stackName, 'attach', 'abc'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stderr.includes('stub failure'), `expected stderr to include stub failure, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('[happy] failed:'), `expected no [happy] failed stack trace, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('[stack] failed:'), `expected no [stack] failed stack trace, got:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('node:internal'), `expected no node:internal stack trace, got:\n${res.stderr}`);
});
