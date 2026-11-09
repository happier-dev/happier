import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { killProcessGroupOwnedByStack, resolvePidStackOwnership } from './utils/proc/ownership.mjs';
import { terminateProcessGroup } from './utils/proc/terminate.mjs';
import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';

const DEAD_OWNER_PID = 2147480210;
const RECORDED_FINGERPRINT = 'win32-cim:2026-11-07T04:27:00.0000000Z';
const NO_DESCENDANTS = { status: 'none' };
const SURVIVING_CHILD = { status: 'present', pids: [4343] };

function spawnLiveProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return child;
}

async function exitProcess(child) {
  child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
}

async function createStack(t, { pid, key }) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-stop-exit-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stackName = 'exit-race-test';
  const baseDir = join(root, 'storage', stackName);
  await mkdir(baseDir, { recursive: true });
  const repoRoot = join(root, 'repo');
  await mkdir(join(repoRoot, 'apps', 'cli', 'dist'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{}\n');
  await writeFile(join(repoRoot, 'apps', 'cli', 'dist', 'index.mjs'), '\n');
  const envPath = join(baseDir, 'env');
  await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`);
  const statePath = join(baseDir, 'stack.runtime.json');
  await recordStackRuntimeUpdate(statePath, {
    version: 1,
    stackName,
    ownerPid: DEAD_OWNER_PID,
    startedAt: new Date().toISOString(),
    processes: { [key]: pid },
    verifiedProcessInstances: { [key]: { pid, fingerprint: RECORDED_FINGERPRINT } },
  });
  return {
    statePath,
    input: {
      rootDir: dirname(dirname(fileURLToPath(import.meta.url))),
      stackName,
      baseDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: join(root, 'storage'),
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_REPO_DIR: repoRoot,
      },
      json: true,
      noDocker: true,
      autoSweep: false,
    },
  };
}

/** A taskkill that fails. The kill and termination owners run for real on their Windows paths. */
function failingTaskkill() {
  const child = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => child.emit('exit', 1));
  return child;
}

function createWindowsStop({ readLiveFingerprint, descendants = NO_DESCENDANTS, beforeOwnershipProof = async () => {} }) {
  const attempts = [];
  return {
    attempts,
    killProcessGroupOwnedByStackImpl: (pid, options) => {
      attempts.push(pid);
      return killProcessGroupOwnedByStack(pid, {
        ...options,
        platform: 'win32',
        readProcessInstanceFingerprintImpl: readLiveFingerprint,
        resolvePidStackOwnershipImpl: async (candidate, context, budget) => {
          await beforeOwnershipProof();
          return await resolvePidStackOwnership(candidate, context, {
            ...budget,
            platform: 'win32',
            readProcessInstanceFingerprintImpl: readLiveFingerprint,
          });
        },
        terminateProcessGroupImpl: (target, termination) => terminateProcessGroup(target, {
          ...termination,
          graceMs: 60,
          boundary: {
            platform: 'win32',
            spawn: failingTaskkill,
            readProcessInstanceFingerprint: readLiveFingerprint,
            observeProcessDescendants: async () => descendants,
          },
        }),
      });
    },
  };
}

function failedReasons(actions) {
  return (actions.finalization.cleanupResults ?? [])
    .filter((result) => result.ok === false)
    .map((result) => result.reason);
}

/** A recorded server that leaves while stop is reading its identity. */
async function stopServerThatExitsDuringItsProof(t, { descendants }) {
  const child = spawnLiveProcess(t);
  const { input, statePath } = await createStack(t, { pid: child.pid, key: 'serverPid' });
  const stop = createWindowsStop({
    readLiveFingerprint: () => null,
    descendants,
    beforeOwnershipProof: () => exitProcess(child),
  });
  const actions = await stopStackWithEnv({ ...input, preserveDaemon: true }, {
    killProcessGroupOwnedByStackImpl: stop.killProcessGroupOwnedByStackImpl,
  });
  return { actions, statePath };
}

test('stop finalizes when a recorded server exits during its ownership proof and leaves no descendants', async (t) => {
  const { actions, statePath } = await stopServerThatExitsDuringItsProof(t, { descendants: NO_DESCENDANTS });

  assert.equal(actions.finalization.reason, 'deleted');
  assert.equal(actions.finalization.finalized, true);
  assert.equal(existsSync(statePath), false);
});

const unprovenServerTrees = [
  ['a child survives', SURVIVING_CHILD, 'descendants_remain'],
  ['its tree cannot be read', { status: 'inconclusive' }, 'leader_absent_without_tree_proof'],
];

for (const [name, descendants, reason] of unprovenServerTrees) {
  test(`stop stays incomplete when a recorded server exits during its proof and ${name}`, async (t) => {
    const { actions, statePath } = await stopServerThatExitsDuringItsProof(t, { descendants });

    assert.equal(actions.finalization.reason, 'cleanup_incomplete');
    assert.deepEqual(failedReasons(actions), [reason]);
    assert.equal(Boolean((await readStackRuntimeStateFile(statePath)).stopRequest), true);
  });
}

/** A daemon the forced attempt fails on, whose graceful stop then runs. */
async function stopDaemonWithGracefulStop(t, {
  descendants = NO_DESCENDANTS,
  gracefulExit = true,
  firstReadFingerprint = RECORDED_FINGERPRINT,
  observePidLivenessImpl,
} = {}) {
  const child = spawnLiveProcess(t);
  const { input, statePath } = await createStack(t, { pid: child.pid, key: 'daemonPid' });
  let exited = false;
  const stop = createWindowsStop({
    readLiveFingerprint: () => (exited ? null : firstReadFingerprint),
    descendants,
  });
  const actions = await stopStackWithEnv(input, {
    killProcessGroupOwnedByStackImpl: stop.killProcessGroupOwnedByStackImpl,
    stopLocalDaemonImpl: async () => {
      if (!gracefulExit) return;
      await exitProcess(child);
      exited = true;
    },
    ...(observePidLivenessImpl ? { observePidLivenessImpl } : {}),
  });
  return { actions, statePath, attempts: stop.attempts };
}

test('stop finalizes when a recorded daemon exits through its graceful stop after a failed forced attempt', async (t) => {
  const { actions, statePath, attempts } = await stopDaemonWithGracefulStop(t);

  assert.equal(attempts.length, 2);
  assert.equal(actions.finalization.reason, 'deleted');
  assert.equal(actions.finalization.finalized, true);
  assert.equal(existsSync(statePath), false);
});

test('stop stays incomplete when a recorded daemon exits gracefully and a child survives', async (t) => {
  const { actions, statePath } = await stopDaemonWithGracefulStop(t, { descendants: SURVIVING_CHILD });

  assert.equal(actions.finalization.reason, 'cleanup_incomplete');
  assert.deepEqual(failedReasons(actions), ['descendants_remain']);
  assert.equal(Boolean((await readStackRuntimeStateFile(statePath)).stopRequest), true);
});

test('stop does not force a recorded daemon twice when it is still alive after the graceful stop', async (t) => {
  const { actions, attempts } = await stopDaemonWithGracefulStop(t, { gracefulExit: false });

  assert.equal(attempts.length, 1);
  assert.equal(actions.finalization.reason, 'cleanup_incomplete');
  assert.deepEqual(failedReasons(actions), ['kill_timeout']);
});

test('stop keeps a failed daemon result when the exit cannot be observed conclusively', async (t) => {
  const { actions, attempts } = await stopDaemonWithGracefulStop(t, {
    observePidLivenessImpl: () => ({ status: 'inconclusive', reason: 'liveness_probe_failed' }),
  });

  assert.equal(attempts.length, 1);
  assert.deepEqual(failedReasons(actions), ['kill_timeout']);
});

test('a reused daemon PID stays a failure even after that PID has gone', async (t) => {
  const { actions, attempts } = await stopDaemonWithGracefulStop(t, {
    firstReadFingerprint: 'win32-cim:2026-11-07T05:00:00.0000000Z',
  });

  assert.equal(attempts.length, 1);
  assert.equal(actions.finalization.reason, 'cleanup_incomplete');
  assert.deepEqual(failedReasons(actions), ['process_instance_mismatch']);
});
