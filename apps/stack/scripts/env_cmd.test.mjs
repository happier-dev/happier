import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture as runNode } from './testkit/stack_script_command_testkit.mjs';

async function withTempRoot(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-env-cmd-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  return tmp;
}

test('hstack env path defaults to main stack env file when no explicit env file is set', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await withTempRoot(t);

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  await mkdir(storageDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    // Prevent loading the user's real ~/.happier-stack/.env via canonical discovery.
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'env.mjs'), 'path', '--json'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const out = JSON.parse(res.stdout || '{}');
  assert.equal(out.ok, true);
  assert.ok(
    typeof out.envPath === 'string' && out.envPath.endsWith('/main/env'),
    `expected main env path to end with /main/env, got: ${out.envPath}`
  );
});

test('hstack env edits the explicit stack env file when HAPPIER_STACK_ENV_FILE is set', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await withTempRoot(t);

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp1';
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_ENV_FILE: envPath,
  };

  const res = await runNode([join(rootDir, 'scripts', 'env.mjs'), 'set', 'FOO=bar'], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const raw = await readFile(envPath, 'utf-8');
  assert.ok(raw.includes('FOO=bar'), `expected FOO in explicit env file\n${raw}`);
});

test('hstack env (no subcommand) prints usage and exits 0', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await withTempRoot(t);

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  await mkdir(storageDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'env.mjs')], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stdout.includes('[env] usage:'), `expected usage output\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
});

test('hstack env list prints keys in text mode', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await withTempRoot(t);

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp1';
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(envPath, 'FOO=bar\n', 'utf-8');

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_ENV_FILE: envPath,
  };

  const res = await runNode([join(rootDir, 'scripts', 'env.mjs'), 'list'], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stdout.includes('FOO=bar'), `expected list output to include FOO=bar\nstdout:\n${res.stdout}`);
});
