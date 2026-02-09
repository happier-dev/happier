import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture } from './testkit/stack_script_command_testkit.mjs';

test('hstack <stack> <cmd> ... rewrites to hstack stack <cmd> <stack> ... when stack exists', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-shorthand-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(envPath, 'FOO=bar\n', 'utf-8');

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
  };

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), stackName, 'env', 'path', '--json'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout || '{}');
  assert.equal(out.ok, true);
  assert.ok(
    typeof out.envPath === 'string' && out.envPath.endsWith(`/${stackName}/env`),
    `expected envPath to end with /${stackName}/env, got: ${out.envPath}`
  );
});

test('hstack does not rewrite shorthand when stack does not exist', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-shorthand-missing-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');

  await mkdir(storageDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
  };

  const res = await runNodeCapture([join(rootDir, 'bin', 'hstack.mjs'), 'missing-stack', 'env', 'path', '--json'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /^\[hstack\] unknown command: missing-stack/m, res.stderr);
});
