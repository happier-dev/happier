import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

async function createStackEnvFixture(t, { stackName = 'exp-test', initialEnv = 'FOO=bar\n' } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-env-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, initialEnv, 'utf-8');

  return {
    envPath,
    stackName,
    baseEnv: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    },
  };
}

test('hstack stack env set/unset writes to stack env file', async (t) => {
  const fixture = await createStackEnvFixture(t);

  const setRes = await runNodeCapture(
    [join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'set', 'OPENAI_API_KEY=sk-test'],
    { cwd: rootDir, env: fixture.baseEnv }
  );
  assert.equal(setRes.code, 0, `expected exit 0, got ${setRes.code}\nstdout:\n${setRes.stdout}\nstderr:\n${setRes.stderr}`);

  const afterSet = await readFile(fixture.envPath, 'utf-8');
  assert.ok(afterSet.includes('OPENAI_API_KEY=sk-test\n'), `expected env file to include OPENAI_API_KEY\n${afterSet}`);

  const unsetRes = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'unset', 'FOO'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(
    unsetRes.code,
    0,
    `expected exit 0, got ${unsetRes.code}\nstdout:\n${unsetRes.stdout}\nstderr:\n${unsetRes.stderr}`
  );

  const afterUnset = await readFile(fixture.envPath, 'utf-8');
  assert.ok(!afterUnset.includes('FOO=bar'), `expected env file to remove FOO\n${afterUnset}`);
});

test('hstack stack env <name> defaults to list', async (t) => {
  const fixture = await createStackEnvFixture(t);

  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stdout.includes('FOO=bar'), `expected stdout to include FOO=bar\nstdout:\n${res.stdout}`);
});

test('hstack stack env set rejects invalid KEY=VALUE assignment form', async (t) => {
  const fixture = await createStackEnvFixture(t);

  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'set', 'INVALID_ASSIGNMENT'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /expected KEY=VALUE/i, `expected invalid assignment guidance in stderr\n${res.stderr}`);
});

test('hstack stack env list fails for unknown stack', async (t) => {
  const fixture = await createStackEnvFixture(t, { stackName: 'known-stack' });
  const missingStack = 'missing-stack';

  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', missingStack, 'list'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /does not exist yet/i, `expected missing stack error\n${res.stderr}`);
});

test('hstack stack env unset missing key is a no-op that keeps existing entries', async (t) => {
  const fixture = await createStackEnvFixture(t, { initialEnv: 'FOO=bar\nBAR=baz\n' });

  const res = await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'env', fixture.stackName, 'unset', 'MISSING_KEY'], {
    cwd: rootDir,
    env: fixture.baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const afterUnset = await readFile(fixture.envPath, 'utf-8');
  assert.ok(afterUnset.includes('FOO=bar'), `expected existing key FOO to remain\n${afterUnset}`);
  assert.ok(afterUnset.includes('BAR=baz'), `expected existing key BAR to remain\n${afterUnset}`);
});
