import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('stopStackWithEnv sweeps repo-local stacks by stack+repo env needles when runtime is missing', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-repo-sweep-'));
  const storageDir = join(tmp, 'storage');
  await mkdir(storageDir, { recursive: true });

  const stackName = 'repo-dev-test-sweep';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });

  const repoDir = dirname(rootDir);
  await writeFile(
    envPath,
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

  // No runtime file (simulates a stale/orphan stackless run), but process still advertises stack+repo.
  child = spawnOwnedSleep({ env: { ...process.env, HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_REPO_DIR: repoDir } });
  assert.ok(Number(child.pid) > 1, 'expected child pid');
  await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label: 'repo-local sweep child (pre-stop)' });
  assert.ok(isAlive(child.pid), 'expected child to be alive');

  await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
    },
    json: true,
    noDocker: true,
    aggressive: false,
    sweepOwned: false,
    autoSweep: true,
  });

  await waitForProcessExit({ pid: child.pid, timeoutMs: 20_000, intervalMs: 50, label: 'repo-local sweep child (post-stop)' });
  assert.ok(!isAlive(child.pid), `expected pid ${child.pid} to be swept by stack+repo needles`);
});

