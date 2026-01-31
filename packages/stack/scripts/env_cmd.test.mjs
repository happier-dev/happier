import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const cleanEnv = {};
    for (const [k, v] of Object.entries(env ?? {})) {
      if (v == null) continue;
      cleanEnv[k] = String(v);
    }
    const proc = spawn(process.execPath, args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

test('happys env path defaults to main stack env file when no explicit env file is set', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-env-cmd-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  await mkdir(storageDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    // Prevent loading the user's real ~/.happy-stacks/.env via canonical discovery.
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
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

test('happys env edits the explicit stack env file when HAPPY_STACKS_ENV_FILE is set', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-env-cmd-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp1';
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_ENV_FILE: envPath,
  };

  const res = await runNode([join(rootDir, 'scripts', 'env.mjs'), 'set', 'FOO=bar'], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const raw = await readFile(envPath, 'utf-8');
  assert.ok(raw.includes('FOO=bar'), `expected FOO in explicit env file\n${raw}`);
});

test('happys env (no subcommand) prints usage and exits 0', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-env-cmd-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  await mkdir(storageDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'env.mjs')], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stdout.includes('[env] usage:'), `expected usage output\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
});

test('happys env list prints keys in text mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-env-cmd-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp1';
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(envPath, 'FOO=bar\n', 'utf-8');

  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_ENV_FILE: envPath,
  };

  const res = await runNode([join(rootDir, 'scripts', 'env.mjs'), 'list'], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stdout.includes('FOO=bar'), `expected list output to include FOO=bar\nstdout:\n${res.stdout}`);
});

