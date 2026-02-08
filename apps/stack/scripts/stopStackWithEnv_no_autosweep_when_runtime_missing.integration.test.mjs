import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive } from './stack_stop_sweeps.testHelper.mjs';

test('stopStackWithEnv does not auto-sweep when autoSweep=false and stack.runtime.json is missing', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-no-autosweep-'));
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  const repoDir = dirname(rootDir);

  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

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

  /** @type {ReturnType<typeof spawnOwnedSleep> | null} */
  let owned = null;
  t.after(async () => {
    const pid = owned?.pid;
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }

    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  owned = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
    },
  });
  assert.ok(Number(owned.pid) > 1, 'expected child pid');
  assert.ok(isAlive(owned.pid), 'expected owned child to be alive');

  const actions = await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    },
    json: true,
    noDocker: true,
    aggressive: false,
    sweepOwned: false,
    autoSweep: false,
  });

  assert.ok(!actions?.sweep, 'expected no sweep field when autoSweep=false');
  await waitForProcessAlive({ pid: owned.pid, timeoutMs: 2_000, intervalMs: 25, label: 'owned process (no autosweep)' });
  assert.ok(isAlive(owned.pid), `expected owned pid ${owned.pid} to still be alive`);
});
