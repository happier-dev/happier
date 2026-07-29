import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { observePsEnvLine } from './utils/proc/ownership.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('stopStackWithEnv repo-local fallback sweeps legacy infra without stopping session processes', async (t) => {
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

  /** @type {Array<ReturnType<typeof spawnOwnedSleep>>} */
  const children = [];
  t.after(async () => {
    for (const child of children) {
      const pid = child?.pid;
      if (!pid || !isAlive(pid)) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  // No runtime file (simulates a stale/orphan stackless run), and legacy infra omitted
  // HAPPIER_STACK_ENV_FILE / HAPPIER_STACK_PROCESS_KIND while still advertising stack+repo.
  const legacyInfra = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_PROCESS_KIND: undefined,
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
  });
  children.push(legacyInfra);
  assert.ok(Number(legacyInfra.pid) > 1, 'expected legacy infra pid');
  await waitForProcessAlive({ pid: legacyInfra.pid, timeoutMs: 2_000, intervalMs: 25, label: 'repo-local sweep child (pre-stop)' });
  assert.ok(isAlive(legacyInfra.pid), 'expected legacy infra child to be alive');

  const sessionLike = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  });
  children.push(sessionLike);
  assert.ok(Number(sessionLike.pid) > 1, 'expected session-like pid');
  await waitForProcessAlive({
    pid: sessionLike.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local session-like process (pre-stop)',
  });
  assert.ok(isAlive(sessionLike.pid), 'expected session-like process to be alive');

  const sessionWithLegacyServerMarkers = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_PROCESS_KIND: 'session',
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
  });
  children.push(sessionWithLegacyServerMarkers);
  assert.ok(Number(sessionWithLegacyServerMarkers.pid) > 1, 'expected session-with-server-markers pid');
  await waitForProcessAlive({
    pid: sessionWithLegacyServerMarkers.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local session with legacy server markers (pre-stop)',
  });
  assert.ok(isAlive(sessionWithLegacyServerMarkers.pid), 'expected session with legacy server markers to be alive');

  const untaggedSessionLike = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_PROCESS_KIND: undefined,
    },
  });
  children.push(untaggedSessionLike);
  assert.ok(Number(untaggedSessionLike.pid) > 1, 'expected untagged session-like pid');
  await waitForProcessAlive({
    pid: untaggedSessionLike.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local untagged session-like process (pre-stop)',
  });
  assert.ok(isAlive(untaggedSessionLike.pid), 'expected untagged session-like process to be alive');

  const identityUnavailableInfra = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
  });
  children.push(identityUnavailableInfra);
  await waitForProcessAlive({
    pid: identityUnavailableInfra.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local identity-unavailable process (pre-stop)',
  });

  const identityTimedOutInfra = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
  });
  children.push(identityTimedOutInfra);
  await waitForProcessAlive({
    pid: identityTimedOutInfra.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local identity-timeout process (pre-stop)',
  });

  const identityMismatchInfra = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_REPO_DIR: repoDir,
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
  });
  children.push(identityMismatchInfra);
  await waitForProcessAlive({
    pid: identityMismatchInfra.pid,
    timeoutMs: 2_000,
    intervalMs: 25,
    label: 'repo-local identity-mismatch process (pre-stop)',
  });

  const stopInput = {
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
  };
  const observeMixedIdentity = async (pid) => {
    if (pid === identityUnavailableInfra.pid) {
      return { status: 'inconclusive', line: null, reason: 'process-identity-unavailable' };
    }
    if (pid === identityTimedOutInfra.pid) {
      return { status: 'inconclusive', line: null, reason: 'process-identity-timeout' };
    }
    if (pid === identityMismatchInfra.pid) {
      return {
        status: 'ok',
        line: `${pid} node HAPPIER_STACK_STACK=foreign HAPPIER_STACK_REPO_DIR=/tmp/foreign npm_lifecycle_event=dev:light npm_package_name=@happier-dev/server`,
        reason: 'ps',
      };
    }
    return await observePsEnvLine(pid);
  };
  const actions = await stopStackWithEnv(stopInput, { observePsEnvLineImpl: observeMixedIdentity });

  await waitForProcessExit({ pid: legacyInfra.pid, timeoutMs: 20_000, intervalMs: 50, label: 'repo-local sweep child (post-stop)' });
  assert.ok(!isAlive(legacyInfra.pid), `expected legacy infra pid ${legacyInfra.pid} to be swept by repo-local infra signature`);
  assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);
  assert.ok(
    isAlive(sessionWithLegacyServerMarkers.pid),
    `expected session-with-server-markers pid ${sessionWithLegacyServerMarkers.pid} to still be alive`,
  );
  assert.ok(isAlive(untaggedSessionLike.pid), `expected untagged session-like pid ${untaggedSessionLike.pid} to still be alive`);
  assert.ok(
    isAlive(identityUnavailableInfra.pid),
    `inconclusive identity must not authorize repo-local direct sweep of pid ${identityUnavailableInfra.pid}`,
  );
  assert.ok(
    isAlive(identityTimedOutInfra.pid),
    `timed-out identity must not authorize repo-local direct sweep of pid ${identityTimedOutInfra.pid}`,
  );
  assert.ok(
    isAlive(identityMismatchInfra.pid),
    `revalidated PID reuse/mismatch must not authorize repo-local direct sweep of pid ${identityMismatchInfra.pid}`,
  );
  assert.ok(
    !actions.sweep.pids.some((entry) => entry.pid === identityUnavailableInfra.pid),
    'cleanup truth must not report an inconclusive identity as swept',
  );
  assert.deepEqual(
    actions.sweep.skipped
      .filter((entry) => [identityUnavailableInfra.pid, identityTimedOutInfra.pid].includes(entry.pid))
      .map((entry) => entry.reason)
      .sort(),
    ['process-identity-timeout', 'process-identity-unavailable'],
    'cleanup truth must preserve why destructive fallback was skipped',
  );
  assert.deepEqual(
    actions.sweep.skipped.find((entry) => entry.pid === identityMismatchInfra.pid),
    { pid: identityMismatchInfra.pid, reason: 'process_identity_mismatch' },
  );
  assert.equal(actions.finalization?.finalized, false);
  assert.equal(actions.finalization?.reason, 'cleanup_incomplete');

  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  await writeFile(runtimeStatePath, JSON.stringify({
    version: 1,
    stackName,
    ownerPid: 999999,
    startedAt: '2026-07-17T08:00:00.000Z',
    processes: {},
  }, null, 2) + '\n', 'utf8');

  const inconclusiveActions = await stopStackWithEnv(stopInput, { observePsEnvLineImpl: observeMixedIdentity });
  assert.equal(inconclusiveActions.finalization?.finalized, false);
  assert.equal(inconclusiveActions.finalization?.reason, 'cleanup_incomplete');
  await access(runtimeStatePath);

  const conclusiveActions = await stopStackWithEnv(stopInput, {
    observePsEnvLineImpl: async (pid) => {
      if (pid === identityUnavailableInfra.pid) {
        return { status: 'not_found', line: null, reason: 'process-not-found' };
      }
      if (pid === identityTimedOutInfra.pid || pid === identityMismatchInfra.pid) {
        return {
          status: 'ok',
          line: `${pid} node HAPPIER_STACK_STACK=foreign HAPPIER_STACK_REPO_DIR=/tmp/foreign npm_lifecycle_event=dev:light npm_package_name=@happier-dev/server`,
          reason: 'ps',
        };
      }
      return await observePsEnvLine(pid);
    },
  });
  assert.deepEqual(
    conclusiveActions.sweep.skipped.find((entry) => entry.pid === identityUnavailableInfra.pid),
    { pid: identityUnavailableInfra.pid, reason: 'process-not-found' },
  );
  assert.deepEqual(
    conclusiveActions.sweep.skipped.find((entry) => entry.pid === sessionWithLegacyServerMarkers.pid),
    { pid: sessionWithLegacyServerMarkers.pid, reason: 'session_process_kind' },
  );
  assert.deepEqual(
    conclusiveActions.sweep.skipped.find((entry) => entry.pid === identityTimedOutInfra.pid),
    { pid: identityTimedOutInfra.pid, reason: 'process_identity_mismatch' },
  );
  assert.ok(isAlive(sessionWithLegacyServerMarkers.pid), 'conclusive session skip must not kill the session process');
  assert.ok(isAlive(identityUnavailableInfra.pid), 'conclusive not-found skip must not issue a direct kill');
  assert.ok(isAlive(identityTimedOutInfra.pid), 'conclusive mismatch skip must not issue a direct kill');
  assert.ok(isAlive(identityMismatchInfra.pid), 'revalidated PID mismatch must remain alive');
  assert.equal(conclusiveActions.finalization?.finalized, true);
  assert.equal(conclusiveActions.finalization?.reason, 'deleted');
  await assert.rejects(access(runtimeStatePath), { code: 'ENOENT' });
});
