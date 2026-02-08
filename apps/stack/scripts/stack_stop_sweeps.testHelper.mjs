import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from './stack_script_cmd.testHelper.mjs';

function toSpawnEnv(env) {
  const cleanEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value == null) continue;
    cleanEnv[key] = String(value);
  }
  return cleanEnv;
}

export function spawnOwnedSleep({ env }) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: toSpawnEnv(env),
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessAlive({
  pid,
  timeoutMs = 2_000,
  intervalMs = 25,
  label = 'process',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`[test] timeout waiting for ${label} pid=${pid} to be alive (${timeoutMs}ms)`);
}

export async function waitForProcessExit({
  pid,
  timeoutMs = 10_000,
  intervalMs = 50,
  label = 'process',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`[test] timeout waiting for ${label} pid=${pid} to exit (${timeoutMs}ms)`);
}

function terminateTrackedProcess(pid) {
  if (!pid) return;
  // Prefer killing the full process group when available; fall back to direct pid kill.
  // This keeps cleanup portable across platforms where negative pid group targeting may fail.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

export async function setupStackStopSweepFixture({
  importMetaUrl,
  t,
  tmpPrefix = 'hstack-stack-stop-sweep-',
  stackName = 'exp1',
} = {}) {
  const scriptsDir = dirname(fileURLToPath(importMetaUrl));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix));
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  const repoDir = join(workspaceDir, 'main');
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');

  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  await mkdir(baseDir, { recursive: true });

  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_UI_BUILD_DIR=${join(baseDir, 'ui')}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const trackedChildren = [];
  const trackChild = (child) => {
    trackedChildren.push(child);
    return child;
  };

  const cleanup = async () => {
    for (const child of trackedChildren) {
      if (!child?.pid) continue;
      terminateTrackedProcess(child.pid);
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  };
  if (t?.after) t.after(cleanup);

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  async function runStackStop(extraArgs = []) {
    return await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'stop', stackName, ...extraArgs], {
      cwd: rootDir,
      env: baseEnv,
    });
  }

  return {
    rootDir,
    tmp,
    stackName,
    homeDir,
    storageDir,
    workspaceDir,
    repoDir,
    baseDir,
    envPath,
    baseEnv,
    trackChild,
    runStackStop,
    cleanup,
  };
}
