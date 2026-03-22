import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildStackFixtureEnv, filterEnvForSpawn } from './core/env_scope.mjs';
import { runNodeCapture } from './core/run_node_capture.mjs';
import { resolveStackRootFromMeta, resolveStackScriptPath } from './core/stack_root.mjs';
import { spawnDetachedInlineNodeTestProcess } from './core/spawn_test_process.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

function toSpawnEnv(env) {
  return filterEnvForSpawn(env, {
    keepKeys: [
      'PATH',
      'HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
      'SHELL',
      'USER',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'TERM',
      'HAPPIER_STACK_STACK',
      'HAPPIER_STACK_ENV_FILE',
      'HAPPIER_STACK_PROCESS_KIND',
      'npm_lifecycle_event',
      'npm_package_name',
    ],
    keepPrefixes: ['HAPPIER_', 'npm_'],
  });
}

export function spawnOwnedSleep({ env }) {
  return spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: toSpawnEnv(env),
    stdio: 'ignore',
  });
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
  timeoutMs = 20_000,
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
  const rootDir = resolveStackRootFromMeta(importMetaUrl);
  const fixture = await createTempFixture(t, { prefix: tmpPrefix });
  const tmp = fixture.root;
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
    await fixture.cleanup();
  };

  const baseEnv = buildStackFixtureEnv({
    homeDir,
    storageDir,
    workspaceDir,
  });

  async function runStackStop(extraArgs = []) {
    return await runNodeCapture([resolveStackScriptPath(rootDir, 'stack.mjs'), 'stop', stackName, ...extraArgs], {
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
