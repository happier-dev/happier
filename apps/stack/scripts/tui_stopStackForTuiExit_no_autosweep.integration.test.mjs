import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackForTuiExit } from './utils/tui/cleanup.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './stack_stop_sweeps.testHelper.mjs';

test('stopStackForTuiExit auto-sweeps infra when stack.runtime.json is missing (and does not kill session-like processes)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-tui-exit-stop-'));
  const storageDir = join(tmp, 'storage');
  await mkdir(storageDir, { recursive: true });
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: storageDir };

  /** @type {ReturnType<typeof spawnOwnedSleep> | null} */
  let infra = null;
  /** @type {ReturnType<typeof spawnOwnedSleep> | null} */
  let sessionLike = null;
  try {
    const stackName = 'exp1';
    const baseDir = join(storageDir, stackName);
    const envPath = join(baseDir, 'env');
    await mkdir(baseDir, { recursive: true });

    const repoDir = dirname(rootDir);
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_REPO_DIR=${repoDir}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
        '',
      ].join('\n'),
      'utf-8'
    );

    infra = spawnOwnedSleep({
      env: {
        ...env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_PROCESS_KIND: 'infra',
      },
    });
    assert.ok(Number(infra.pid) > 1, 'expected infra child pid');
    assert.ok(isAlive(infra.pid), 'expected infra child to be alive');

    sessionLike = spawnOwnedSleep({
      env: {
        ...env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_PROCESS_KIND: 'session',
      },
    });
    assert.ok(Number(sessionLike.pid) > 1, 'expected session-like child pid');
    assert.ok(isAlive(sessionLike.pid), 'expected session-like child to be alive');

    await waitForProcessAlive({ pid: infra.pid, timeoutMs: 2_000, intervalMs: 25, label: 'infra process (pre-sweep)' });
    await waitForProcessAlive({
      pid: sessionLike.pid,
      timeoutMs: 2_000,
      intervalMs: 25,
      label: 'session-like process (pre-sweep)',
    });

    const actions = await stopStackForTuiExit({ rootDir, stackName, env, json: true, noDocker: true });
    assert.ok(actions?.sweep, 'expected stopStackForTuiExit to auto-sweep infra when runtime state is missing');

    await waitForProcessExit({ pid: infra.pid, timeoutMs: 10_000, intervalMs: 50, label: 'infra process (post-sweep)' });
    assert.ok(!isAlive(infra.pid), `expected infra pid ${infra.pid} to be stopped by sweep`);
    assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);
  } finally {
    for (const child of [infra, sessionLike]) {
      const pid = child?.pid;
      if (!pid || !isAlive(pid)) continue;
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
  }
});
