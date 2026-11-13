import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { killProcessGroupOwnedByStack, resolvePidStackOwnership } from './utils/proc/ownership.mjs';
import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';

const DEAD_OWNER_PID = 2147480200;
const DEAD_PROCESS_PID = 2147480201;

function spawnLiveProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return child;
}

async function createStack(t, { pid, ephemeral = false, identity = 'unverified', key = 'serverDrainingPid' }) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-stop-unverified-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stackName = 'unverified-test';
  const baseDir = join(root, 'storage', stackName);
  await mkdir(baseDir, { recursive: true });
  const envPath = join(baseDir, 'env');
  await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`);
  const statePath = join(baseDir, 'stack.runtime.json');
  await recordStackRuntimeUpdate(statePath, {
    version: 1,
    stackName,
    ephemeral,
    ownerPid: DEAD_OWNER_PID,
    processes: { [key]: pid },
    ...(identity === 'unverified'
      ? { unverifiedProcessPids: [pid] }
      : { verifiedProcessInstances: { [key]: { pid, fingerprint: identity } } }),
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
      },
      json: true,
      noDocker: true,
      autoSweep: false,
      preserveDaemon: true,
    },
  };
}

/** The real kill owner on its POSIX path, where a null fingerprint would capture the current PID. */
function createKillOwnerTrap() {
  const trap = { reads: 0, kills: [] };
  trap.killProcessGroupOwnedByStackImpl = (pid, options) => {
    trap.kills.push({ pid, options });
    return killProcessGroupOwnedByStack(pid, {
      ...options,
      platform: 'linux',
      readProcessInstanceFingerprintImpl: () => {
        trap.reads += 1;
        return 'linux-proc:whatever-has-this-pid-now';
      },
      resolvePidStackOwnershipImpl: async () => ({ status: 'owned', owned: true, reason: 'test' }),
      terminateProcessGroupImpl: async () => ({ ok: true, signal: 'SIGTERM' }),
      terminateProcessPidImpl: async () => ({ ok: true, signal: 'SIGTERM' }),
      getProcessGroupIdImpl: async () => null,
    });
  };
  return trap;
}

for (const ephemeral of [false, true]) {
  test(`stop refuses a live unverified process and stays incomplete (ephemeral=${ephemeral})`, async (t) => {
    const child = spawnLiveProcess(t);
    const { input, statePath } = await createStack(t, { pid: child.pid, ephemeral });
    const trap = createKillOwnerTrap();

    const actions = await stopStackWithEnv(input, {
      killProcessGroupOwnedByStackImpl: trap.killProcessGroupOwnedByStackImpl,
      // Stop also asks for its own group, so only the unverified PID is a violation.
      getProcessGroupIdImpl: async (pid) => {
        assert.notEqual(pid, child.pid, 'an unverified process has no fallback path');
        return null;
      },
      terminateProcessPidImpl: async () => assert.fail('an unverified process must not be terminated'),
      terminateProcessGroupImpl: async () => assert.fail('an unverified process must not be terminated'),
    });

    assert.deepEqual(trap.kills, []);
    assert.equal(trap.reads, 0);
    assert.equal(actions.finalization.reason, 'cleanup_incomplete');
    const state = await readStackRuntimeStateFile(statePath);
    assert.deepEqual(state.processInstances.processes.serverDrainingPid, {
      pid: child.pid,
      fingerprint: null,
      unverified: true,
    });
  });
}

test('stop finishes once an unverified process is gone', async (t) => {
  const { input } = await createStack(t, { pid: DEAD_PROCESS_PID });
  const trap = createKillOwnerTrap();

  const actions = await stopStackWithEnv(input, {
    killProcessGroupOwnedByStackImpl: trap.killProcessGroupOwnedByStackImpl,
  });

  assert.deepEqual(trap.kills, []);
  assert.notEqual(actions.finalization.reason, 'cleanup_incomplete');
});

test('sweeps leave a live unverified process alone even when its environment matches', async (t) => {
  const child = spawnLiveProcess(t);
  const { input } = await createStack(t, { pid: child.pid });
  const trap = createKillOwnerTrap();

  const actions = await stopStackWithEnv({ ...input, sweepOwned: true }, {
    killProcessGroupOwnedByStackImpl: trap.killProcessGroupOwnedByStackImpl,
    listPsPidsForEnvQueriesImpl: async () => [[child.pid], [], [], []],
  });

  assert.deepEqual(trap.kills, []);
  assert.deepEqual(actions.sweep.skipped, [{ pid: child.pid, reason: 'process_instance_unverified' }]);
});

test('stop still kills a verified process through its recorded identity', async (t) => {
  const child = spawnLiveProcess(t);
  const { input } = await createStack(t, { pid: child.pid, identity: 'linux-proc:spawn-created' });
  const trap = createKillOwnerTrap();

  await stopStackWithEnv(input, { killProcessGroupOwnedByStackImpl: trap.killProcessGroupOwnedByStackImpl });

  assert.equal(trap.kills.length, 1);
  assert.equal(trap.kills[0].pid, child.pid);
  assert.equal(trap.kills[0].options.processInstanceFingerprint, 'linux-proc:spawn-created');
  assert.equal(trap.reads, 0);
});

test('repo-local sweep leaves a live unverified process alone', async (t) => {
  const child = spawnLiveProcess(t);
  const { input } = await createStack(t, { pid: child.pid });
  const stackName = 'repo-unverified-test';
  const repoLocal = {
    ...input,
    stackName,
    autoSweep: true,
    env: { ...input.env, HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_REPO_DIR: input.baseDir },
  };

  const actions = await stopStackWithEnv(repoLocal, {
    killProcessGroupOwnedByStackImpl: async () => assert.fail('the first sweep has nothing to kill'),
    listPsPidsForEnvQueriesImpl: async () => [[], [], [child.pid], []],
    observePsEnvLineImpl: async () => assert.fail('an unverified process must not be inspected for ownership'),
    readProcessInstanceFingerprintImpl: () => assert.fail('an unverified process must not be read'),
  });

  assert.deepEqual(actions.sweep.skipped, [{ pid: child.pid, reason: 'process_instance_unverified' }]);
});

const RECORDED_FINGERPRINT = 'win32-cim:2026-11-07T01:01:47.3696250Z';

/** The real kill owner and identity owner on Windows, with only the live identity read replaced. */
function createLiveIdentityStop(readLiveFingerprint) {
  const terminated = [];
  return {
    terminated,
    killProcessGroupOwnedByStackImpl: (pid, options) => killProcessGroupOwnedByStack(pid, {
      ...options,
      platform: 'win32',
      resolvePidStackOwnershipImpl: (candidate, context, budget) => resolvePidStackOwnership(candidate, context, {
        ...budget,
        platform: 'win32',
        readProcessInstanceFingerprintImpl: readLiveFingerprint,
      }),
      terminateProcessGroupImpl: async (target, termination) => {
        terminated.push({ target, fingerprint: termination.processInstanceFingerprint });
        return { ok: true, signal: 'SIGKILL' };
      },
    }),
  };
}

const failedLiveReads = [
  ['the live read returns nothing', () => null, 'process_instance_unavailable'],
  ['the live read differs', () => 'win32-cim:2026-11-07T02:00:00.0000000Z', 'process_instance_mismatch'],
];

for (const [name, readLiveFingerprint, reason] of failedLiveReads) {
  test(`a recorded server is refused and stop says why when ${name}`, async (t) => {
    const child = spawnLiveProcess(t);
    const { input, statePath } = await createStack(t, { pid: child.pid, identity: RECORDED_FINGERPRINT, key: 'serverPid' });
    const stop = createLiveIdentityStop(readLiveFingerprint);
    const warnings = [];
    t.mock.method(console, 'warn', (message) => warnings.push(String(message)));

    const actions = await stopStackWithEnv({ ...input, json: false }, {
      killProcessGroupOwnedByStackImpl: stop.killProcessGroupOwnedByStackImpl,
    });

    assert.deepEqual(stop.terminated, []);
    assert.equal(actions.finalization.reason, 'cleanup_incomplete');
    assert.deepEqual(
      actions.finalization.cleanupResults.filter((result) => result.ok === false).map((result) => result.reason),
      [reason],
    );
    const refusal = warnings.find((message) => message.includes(`refusing to kill serverPid pid=${child.pid}`));
    assert.ok(refusal, 'the refusal must be printed');
    assert.equal(refusal.includes(reason), true, `the refusal must name ${reason}: ${refusal}`);
    const state = await readStackRuntimeStateFile(statePath);
    assert.equal(state.processes.serverPid, child.pid);
    assert.equal(state.processInstances.processes.serverPid.fingerprint, RECORDED_FINGERPRINT);
    assert.equal(Boolean(state.stopRequest), true);
  });
}

test('a recorded server whose live identity matches is stopped through that identity', async (t) => {
  const child = spawnLiveProcess(t);
  const { input } = await createStack(t, { pid: child.pid, identity: RECORDED_FINGERPRINT, key: 'serverPid' });
  const stop = createLiveIdentityStop(() => RECORDED_FINGERPRINT);

  await stopStackWithEnv(input, { killProcessGroupOwnedByStackImpl: stop.killProcessGroupOwnedByStackImpl });

  assert.deepEqual(stop.terminated, [{ target: child.pid, fingerprint: RECORDED_FINGERPRINT }]);
});
