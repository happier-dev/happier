import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('hapsta stack env set/unset writes to stack env file', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-env-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, 'FOO=bar\n', 'utf-8');

  const baseEnv = {
    ...process.env,
    // Prevent loading the user's real ~/.happier-stack/.env via canonical discovery.
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
  };

  const setRes = await runNode(
    [join(rootDir, 'scripts', 'stack.mjs'), 'env', stackName, 'set', 'OPENAI_API_KEY=sk-test'],
    { cwd: rootDir, env: baseEnv }
  );
  assert.equal(setRes.code, 0, `expected exit 0, got ${setRes.code}\nstdout:\n${setRes.stdout}\nstderr:\n${setRes.stderr}`);

  const afterSet = await readFile(envPath, 'utf-8');
  assert.ok(afterSet.includes('OPENAI_API_KEY=sk-test\n'), `expected env file to include OPENAI_API_KEY\n${afterSet}`);

  const unsetRes = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'env', stackName, 'unset', 'FOO'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(
    unsetRes.code,
    0,
    `expected exit 0, got ${unsetRes.code}\nstdout:\n${unsetRes.stdout}\nstderr:\n${unsetRes.stderr}`
  );

  const afterUnset = await readFile(envPath, 'utf-8');
  assert.ok(!afterUnset.includes('FOO=bar'), `expected env file to remove FOO\n${afterUnset}`);
});

test('hapsta stack env <name> defaults to list', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-env-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, 'FOO=bar\n', 'utf-8');

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'env', stackName], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stdout.includes('FOO=bar'), `expected stdout to include FOO=bar\nstdout:\n${res.stdout}`);
});
