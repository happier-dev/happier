import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => (stdout += String(data)));
    proc.stderr.on('data', (data) => (stderr += String(data)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 128 : 0), signal, stdout, stderr }));
  });
}

test('hstack stack pr rejects stack names that normalize to reserved main', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-pr-main-'));

  try {
    const workspaceDir = join(tmp, 'workspace');
    const storageDir = join(tmp, 'storage');
    const homeDir = join(tmp, 'home');
    const sandboxDir = join(tmp, 'sandbox');

    const env = {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
    };

    const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'pr', 'Main'], { cwd: rootDir, env });
    assert.notEqual(res.code, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(
      `${res.stderr}\n${res.stdout}`,
      /stack name "main" is reserved/i,
      `expected reserved-name error\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack stack pr rejects names that normalize to an existing stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-pr-collision-'));

  try {
    const workspaceDir = join(tmp, 'workspace');
    const storageDir = join(tmp, 'storage');
    const homeDir = join(tmp, 'home');
    const sandboxDir = join(tmp, 'sandbox');

    await mkdir(join(storageDir, 'dev-auth'), { recursive: true });
    await writeFile(join(storageDir, 'dev-auth', 'env'), 'HAPPIER_STACK_STACK=dev-auth\n', 'utf8');

    const env = {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
    };

    const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'pr', 'Dev-Auth'], { cwd: rootDir, env });
    assert.notEqual(res.code, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(
      `${res.stderr}\n${res.stdout}`,
      /stack already exists/i,
      `expected collision error\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
