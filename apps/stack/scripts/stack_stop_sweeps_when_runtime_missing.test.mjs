import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

function spawnOwnedSleep({ env }) {
  const cleanEnv = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v == null) continue;
    cleanEnv[k] = String(v);
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: cleanEnv,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('hstack stack stop sweeps owned processes when stack.runtime.json is missing', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-stop-sweep-'));
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  const repoDir = join(workspaceDir, 'main');

  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });

  const stackName = 'exp1';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });

  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_UI_BUILD_DIR=${join(baseDir, 'ui')}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const owned = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
    },
  });
  assert.ok(Number(owned.pid) > 1, 'expected child pid');
  assert.ok(isAlive(owned.pid), 'expected owned child to be alive');

  const env = {
    ...process.env,
    // Prevent canonical discovery from reading the real machine install.
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'stop', stackName, '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  // Give the process group kill a moment.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!isAlive(owned.pid), `expected owned pid ${owned.pid} to be stopped`);
});

