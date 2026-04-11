import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('stopStackWithEnv sweeps infra tagged processes when HAPPIER_STACK_ENV_FILE uses a ~/ override', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-home-env-'));
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  const repoDir = dirname(rootDir);

  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const stackName = 'exp1';
  const baseDir = join(storageDir, stackName);
  const rawEnvPath = `~/.happier/stacks/${stackName}/env`;
  const expandedEnvPath = join(homeDir, '.happier', 'stacks', stackName, 'env');
  await mkdir(dirname(expandedEnvPath), { recursive: true });
  await mkdir(baseDir, { recursive: true });

  await writeFile(
    expandedEnvPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  /** @type {ReturnType<typeof spawnOwnedSleep> | null} */
  let child = null;
  t.after(async () => {
    const pid = child?.pid;
    if (pid && isAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  child = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: expandedEnvPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  });
  assert.ok(Number(child.pid) > 1, 'expected child pid');
  await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label: 'home-relative env child (pre-stop)' });
  assert.ok(isAlive(child.pid), 'expected child to be alive');

  await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HOME: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: rawEnvPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    },
    json: true,
    noDocker: true,
    aggressive: false,
    sweepOwned: false,
    autoSweep: true,
    preserveDaemon: true,
  });

  await waitForProcessExit({ pid: child.pid, timeoutMs: 20_000, intervalMs: 50, label: 'home-relative env child (post-stop)' });
  assert.ok(!isAlive(child.pid), `expected pid ${child.pid} to be swept via the expanded env-file needle`);
});
