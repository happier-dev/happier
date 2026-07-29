import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('stopStackWithEnv kills only legacy ephemeral runtime pids with an infra/server signature', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-ephemeral-runtime-'));
  const rootDir = join(tmp, 'repo');
  const storageDir = join(tmp, 'storage');
  await mkdir(storageDir, { recursive: true });
  for (const component of ['ui', 'cli', 'server']) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(join(rootDir, 'apps', component), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(rootDir, 'apps', component, 'package.json'), '{}\n', 'utf8');
  }

  const stackName = 'repo-dev-test';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  await mkdir(baseDir, { recursive: true });

  // Minimal env file to make the stack "exist".
  const repoDir = rootDir;
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
  /** @type {ReturnType<typeof spawnOwnedSleep> | null} */
  let markerLightChild = null;
  t.after(async () => {
    for (const pid of [child?.pid, markerLightChild?.pid]) {
      if (pid && isAlive(pid)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  // Simulate older stackless infra: stack name set, but no env/home markers.
  child = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: undefined,
      HAPPIER_STACK_CLI_HOME_DIR: undefined,
      HAPPIER_STACK_ENV_FILE: undefined,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  });
  markerLightChild = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: undefined,
      HAPPIER_STACK_CLI_HOME_DIR: undefined,
      HAPPIER_STACK_ENV_FILE: undefined,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_PROCESS_KIND: '',
    },
  });
  assert.ok(Number(child.pid) > 1, 'expected child pid');
  assert.ok(Number(markerLightChild.pid) > 1, 'expected marker-light child pid');
  await waitForProcessAlive({ pid: child.pid, timeoutMs: 2_000, intervalMs: 25, label: 'ephemeral runtime child (pre-stop)' });
  await waitForProcessAlive({ pid: markerLightChild.pid, timeoutMs: 2_000, intervalMs: 25, label: 'marker-light child (pre-stop)' });
  assert.ok(isAlive(child.pid), 'expected child to be alive');
  assert.ok(isAlive(markerLightChild.pid), 'expected marker-light child to be alive');

  // Runtime state file records the pid under this stack, and marks it ephemeral.
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify(
      {
        version: 1,
        stackName,
        script: 'dev.mjs',
        ephemeral: true,
        ownerPid: null,
        ports: {},
        processes: { serverPid: child.pid, watcherPid: markerLightChild.pid },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

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
    autoSweep: false,
  });

  await waitForProcessExit({ pid: child.pid, timeoutMs: 20_000, intervalMs: 50, label: 'ephemeral runtime child (post-stop)' });
  assert.ok(!isAlive(child.pid), `expected pid ${child.pid} to be killed by stopStackWithEnv fallback`);
  assert.ok(isAlive(markerLightChild.pid), `expected marker-light pid ${markerLightChild.pid} to survive stopStackWithEnv fallback`);
});
