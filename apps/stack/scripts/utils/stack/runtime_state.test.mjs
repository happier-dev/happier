import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as runtimeStateModule from './runtime_state.mjs';
import { readProcessInstanceFingerprintSync } from '../../../../../packages/cli-common/processInstance.mjs';
import { killProcessGroupOwnedByStack } from '../proc/ownership.mjs';

import {
  readStackServerLifecycle,
  createStackDevProxyRuntimePatch,
  createStackServerRuntimeProcessPatch,
  getStackRuntimeProcessEntries,
  getStackRuntimeProcessInstanceFingerprint,
  readStackRuntimeStateFile,
  recordStackRuntimeServerPids,
  recordStackRuntimeServerLifecycle,
  recordStackRuntimeStart,
  recordStackRuntimeStopRequest,
  recordStackRuntimeUpdate,
  captureStackRuntimeStopSnapshot,
  deleteStackRuntimeStateIfOwnedBy,
  finalizeStackRuntimeStop,
  resolveTrustedStackRuntimeServerPort,
  withStackRuntimeStartClaim,
  withStackRuntimeStopTransaction,
} from './runtime_state.mjs';

test('runtime state publishes exact process-incarnation projections for lifecycle and process owners', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-process-instance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');

  await recordStackRuntimeStart(statePath, {
    stackName: 'process-instance',
    ownerPid: process.pid,
    processes: { daemonPid: process.pid, daemonPids: [process.pid] },
  });

  const runtime = await readStackRuntimeStateFile(statePath);
  const ownerFingerprint = getStackRuntimeProcessInstanceFingerprint(runtime, 'ownerPid', process.pid);
  const daemonFingerprint = getStackRuntimeProcessInstanceFingerprint(runtime, 'daemonPid', process.pid);
  const daemonSetFingerprint = getStackRuntimeProcessInstanceFingerprint(runtime, 'daemonPids', process.pid);
  assert.equal(typeof ownerFingerprint, 'string');
  assert.equal(daemonFingerprint, ownerFingerprint);
  assert.equal(daemonSetFingerprint, ownerFingerprint);
  assert.deepEqual(
    getStackRuntimeProcessEntries(runtime).map(({ key, pid, processInstanceFingerprint }) => ({
      key,
      pid,
      processInstanceFingerprint,
    })),
    [
      { key: 'daemonPid', pid: process.pid, processInstanceFingerprint: ownerFingerprint },
      { key: 'daemonPids', pid: process.pid, processInstanceFingerprint: ownerFingerprint },
    ],
  );
});

test('unrelated runtime updates preserve producer-recorded identity and Windows refuses a same-pid successor', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-process-successor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  const recordedFingerprint = 'win32-cim:recorded-owner';

  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      stackName: 'process-successor',
      ownerPid: process.pid,
      processes: { daemonPid: process.pid },
      processInstances: {
        owner: { pid: process.pid, fingerprint: recordedFingerprint },
        processes: {
          daemonPid: { pid: process.pid, fingerprint: recordedFingerprint },
        },
      },
    }) + '\n',
    'utf8',
  );

  await recordStackRuntimeUpdate(statePath, { diagnosticOnly: true });
  const runtime = await readStackRuntimeStateFile(statePath);
  const persistedFingerprint = getStackRuntimeProcessInstanceFingerprint(
    runtime,
    'daemonPid',
    process.pid,
  );
  const currentSuccessorFingerprint = readProcessInstanceFingerprintSync(process.pid);
  let terminationCalls = 0;
  const termination = await killProcessGroupOwnedByStack(process.pid, {
    platform: 'win32',
    processInstanceFingerprint: persistedFingerprint,
    readProcessInstanceFingerprintSyncImpl: () => currentSuccessorFingerprint,
    observePidLivenessImpl: () => ({ status: 'alive' }),
    terminateProcessGroupImpl: async () => {
      terminationCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(persistedFingerprint, recordedFingerprint);
  assert.deepEqual(termination, { killed: false, reason: 'process_instance_changed' });
  assert.equal(terminationCalls, 0);
});

test('stop transaction releases the mutation lock while external owner shutdown runs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-unlocked-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'external-stop', ownerPid: process.pid, ports: {} });

  let captureFinished = false;
  let captureFinishedDuringExternalShutdown = false;
  let capturePromise = null;
  await withStackRuntimeStopTransaction(statePath, { preserveDaemon: false }, async () => {
    capturePromise = captureStackRuntimeStopSnapshot(statePath).then(() => { captureFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    captureFinishedDuringExternalShutdown = captureFinished;
  });
  await capturePromise;
  assert.equal(captureFinishedDuringExternalShutdown, true, 'the lifecycle owner must be able to capture state before external shutdown returns');
});

test('fresh stop finalization preserves a successor published during unlocked shutdown', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-successor-during-wait-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'successor-during-wait', ownerPid: 501, processes: { serverPid: 601 } });

  const result = await withStackRuntimeStopTransaction(statePath, {}, async (transaction) => {
    await recordStackRuntimeUpdate(statePath, {
      ownerPid: 502,
      startedAt: '2026-07-18T10:00:00.000Z',
      processes: { serverPid: 602 },
    });
    return await transaction.finalize({ cleanupResults: [{ ok: true, step: 'predecessor' }] });
  });

  assert.equal(result.finalized, false);
  assert.equal(result.reason, 'successor_state');
  assert.equal((await readStackRuntimeStateFile(statePath)).ownerPid, 502);
});

test('owner-initiated finalization preserves an external stop request published during shutdown', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-owner-external-stop-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'external-stop-race', ownerPid: process.pid, ports: {} });
  const ownerShutdownSnapshot = await captureStackRuntimeStopSnapshot(statePath);
  await recordStackRuntimeStopRequest(statePath, {
    requestedBy: 'external canonical stop',
    reason: 'test early cleanup window',
    preserveDaemon: false,
  });

  const result = await finalizeStackRuntimeStop(statePath, {
    expected: ownerShutdownSnapshot,
    requireNoStopRequest: true,
    cleanupResults: [{ ok: true, step: 'owner child cleanup' }],
  });

  assert.equal(result.finalized, false);
  assert.equal(result.reason, 'external_stop_in_progress');
  assert.equal((await readStackRuntimeStateFile(statePath)).stopRequest?.requestedBy, 'external canonical stop');
});

test('owner identity deletion cannot erase a canonical stop request', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-owned-delete-stop-fence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  const runtime = await recordStackRuntimeStart(statePath, { stackName: 'owned-delete-stop-fence', ownerPid: process.pid, ports: {} });
  await recordStackRuntimeStopRequest(statePath, { requestedBy: 'canonical stop', preserveDaemon: false });

  assert.equal(await deleteStackRuntimeStateIfOwnedBy(statePath, runtime), false);
  assert.equal((await readStackRuntimeStateFile(statePath)).stopRequest?.requestedBy, 'canonical stop');
});

test('recordStackRuntimeStart clears runtime-only launch provenance when a source lifecycle replaces it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-source-provenance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');

  await recordStackRuntimeStart(statePath, {
    stackName: 'runtime-to-source',
    script: 'run.mjs',
    ownerPid: process.pid,
    runtimeSnapshotId: 'snapshot-1',
    serveUi: true,
  });
  const sourceRuntime = await recordStackRuntimeStart(statePath, {
    stackName: 'runtime-to-source',
    script: 'dev.mjs',
    ownerPid: process.pid,
  });

  assert.equal(sourceRuntime.runtimeSnapshotId, null);
  assert.equal(sourceRuntime.serveUi, null);
});

test('stop finalization preserves a successor and same-owner new generation/process membership', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-successor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'race', ownerPid: 501, processes: { serverPid: 601 }, serverProxy: { reloadGeneration: 1 } });
  const stop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
  await recordStackRuntimeUpdate(statePath, { ownerPid: 501, processes: { serverPid: 602 }, serverProxy: { reloadGeneration: 2 } });
  const result = await finalizeStackRuntimeStop(statePath, { expected: stop.expected, preserveDaemon: false });
  assert.equal(result.finalized, false);
  assert.equal(result.reason, 'successor_state');
  assert.equal((await readStackRuntimeStateFile(statePath)).processes.serverPid, 602);
});

test('stop finalization preserves a same-pid successor with identical process and generation membership', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-incarnation-successor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  const input = {
    stackName: 'incarnation-successor',
    ownerPid: process.pid,
    processes: { serverPid: 601 },
    serverProxy: { reloadGeneration: 1 },
  };
  const first = await recordStackRuntimeStart(statePath, input);
  const stop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
  const successorStartedAt = new Date(Date.parse(first.startedAt) + 1).toISOString();
  await recordStackRuntimeUpdate(statePath, { startedAt: successorStartedAt });

  assert.notEqual(successorStartedAt, first.startedAt);
  const result = await finalizeStackRuntimeStop(statePath, { expected: stop.expected, preserveDaemon: false });
  assert.equal(result.finalized, false);
  assert.equal(result.reason, 'successor_state');
  assert.equal((await readStackRuntimeStateFile(statePath)).startedAt, successorStartedAt);
});

test('ownerless stop finalization rejects a replacement stop transaction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-ownerless-stop-successor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  const firstRequestedAt = '2026-07-24T14:37:26.614Z';
  await recordStackRuntimeUpdate(statePath, {
    stackName: 'ownerless-stop-successor',
    ownerPid: null,
    startedAt: null,
    processes: {},
    stopRequest: {
      signal: 'SIGTERM',
      requestedBy: 'stack stop',
      reason: 'explicit stack stop',
      preserveDaemon: false,
      requestedAt: firstRequestedAt,
    },
  });
  const stop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
  assert.equal(stop.expected.stopRequestedAt, firstRequestedAt);

  const successorRequestedAt = '2026-07-24T14:37:27.614Z';
  await recordStackRuntimeUpdate(statePath, {
    stopRequest: { requestedAt: successorRequestedAt },
  });
  const result = await finalizeStackRuntimeStop(statePath, {
    expected: stop.expected,
    preserveDaemon: false,
  });

  assert.equal(result.finalized, false);
  assert.equal(result.reason, 'successor_state');
  assert.equal((await readStackRuntimeStateFile(statePath)).stopRequest.requestedAt, successorRequestedAt);
});

test('stop finalization fails closed for missing or malformed snapshot and current lifecycle identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-invalid-snapshot-incarnation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const scenario of [
    { name: 'missing-expected', expectedStartedAt: null },
    { name: 'malformed-expected', expectedStartedAt: 'not-a-timestamp' },
    { name: 'missing-current', currentStartedAt: null },
    { name: 'malformed-current', currentStartedAt: 'not-a-timestamp' },
  ]) {
    const statePath = join(dir, `${scenario.name}.json`);
    await recordStackRuntimeStart(statePath, {
      stackName: scenario.name,
      ownerPid: process.pid,
      processes: { serverPid: 601 },
    });
    const stop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
    const expected = { ...stop.expected };
    if ('expectedStartedAt' in scenario) {
      if (scenario.expectedStartedAt === null) delete expected.startedAt;
      else expected.startedAt = scenario.expectedStartedAt;
    }
    if ('currentStartedAt' in scenario) {
      await recordStackRuntimeUpdate(statePath, { startedAt: scenario.currentStartedAt });
    }

    const result = await finalizeStackRuntimeStop(statePath, { expected, preserveDaemon: false });
    assert.equal(result.finalized, false, scenario.name);
    assert.equal(result.reason, 'successor_state', scenario.name);
    assert.notEqual(await readStackRuntimeStateFile(statePath), null, scenario.name);
  }
});

test('deleteStackRuntimeStateIfOwnedBy requires the caller snapshot and rejects a same-pid successor', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-owned-delete-incarnation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const staleStatePath = join(dir, 'same-pid-successor.json');
  const predecessor = await recordStackRuntimeStart(staleStatePath, {
    stackName: 'same-pid-successor',
    ownerPid: process.pid,
    ports: {},
  });
  const predecessorSnapshot = await captureStackRuntimeStopSnapshot(staleStatePath);
  const successorStartedAt = new Date(Date.parse(predecessor.startedAt) + 1).toISOString();
  await recordStackRuntimeUpdate(staleStatePath, { startedAt: successorStartedAt });

  assert.equal(await deleteStackRuntimeStateIfOwnedBy(staleStatePath, process.pid), false, 'PID-only overload must fail closed');
  assert.equal(await deleteStackRuntimeStateIfOwnedBy(staleStatePath, predecessorSnapshot), false);
  assert.equal(await deleteStackRuntimeStateIfOwnedBy(staleStatePath, {
    ownerPid: predecessor.ownerPid,
    startedAt: predecessor.startedAt,
  }), false);
  assert.equal((await readStackRuntimeStateFile(staleStatePath)).startedAt, successorStartedAt);

  const missingStartedAt = { ...predecessorSnapshot };
  delete missingStartedAt.startedAt;
  assert.equal(await deleteStackRuntimeStateIfOwnedBy(staleStatePath, missingStartedAt), false);
  assert.equal(await deleteStackRuntimeStateIfOwnedBy(staleStatePath, {
    ...predecessorSnapshot,
    startedAt: 'not-a-timestamp',
  }), false);
  assert.equal(await deleteStackRuntimeStateIfOwnedBy(staleStatePath, {
    ownerPid: 'not-a-pid',
    startedAt: successorStartedAt,
  }), false);
  assert.equal(await deleteStackRuntimeStateIfOwnedBy(staleStatePath, {
    ownerPid: process.pid + 1,
    startedAt: successorStartedAt,
  }), false);

  const validStatePath = join(dir, 'valid.json');
  await recordStackRuntimeStart(validStatePath, { stackName: 'valid', ownerPid: process.pid, ports: {} });
  const validSnapshot = await captureStackRuntimeStopSnapshot(validStatePath);
  assert.equal(await deleteStackRuntimeStateIfOwnedBy(validStatePath, validSnapshot), true);
  assert.equal(await readStackRuntimeStateFile(validStatePath), null);

  const validIdentityPath = join(dir, 'valid-identity.json');
  const validRuntime = await recordStackRuntimeStart(validIdentityPath, {
    stackName: 'valid-identity',
    ownerPid: process.pid,
    ports: {},
  });
  assert.equal(await deleteStackRuntimeStateIfOwnedBy(validIdentityPath, {
    ownerPid: validRuntime.ownerPid,
    startedAt: validRuntime.startedAt,
  }), true);
  assert.equal(await readStackRuntimeStateFile(validIdentityPath), null);
});

test('stop finalization preserves ownership truth when any targeted cleanup is unconfirmed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-cleanup-incomplete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'cleanup', ownerPid: 801, processes: { serverPid: 802 } });
  const stop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });

  const result = await finalizeStackRuntimeStop(statePath, {
    expected: stop.expected,
    preserveDaemon: false,
    cleanupResults: [{ ok: true }, { ok: false }],
  });

  assert.deepEqual(result, {
    finalized: false,
    reason: 'cleanup_incomplete',
    cleanupResults: [{ ok: true }, { ok: false }],
  });
  assert.equal((await readStackRuntimeStateFile(statePath)).ownerPid, 801);
});

test('incomplete expected-owner cleanup releases the lock but blocks a different owner while the expected owner is live', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-incomplete-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'cleanup', ownerPid: process.pid, processes: { serverPid: 999_992 } });
  const current = await readStackRuntimeStateFile(statePath);
  const stop = await recordStackRuntimeStopRequest(statePath, {
    expectedOwnerPid: process.pid,
    expectedOwnerStartedAt: current.startedAt,
  });
  const incomplete = await finalizeStackRuntimeStop(statePath, {
    expected: stop.expected,
    cleanupResults: [{ ok: false, step: 'server' }],
  });
  assert.equal(incomplete.reason, 'cleanup_incomplete');

  await assert.rejects(
    () => withStackRuntimeStartClaim(statePath, { stackName: 'cleanup' }, async ({ recordStart }) => {
      await recordStart({ stackName: 'cleanup', ownerPid: process.pid, ports: {} });
    }),
    /stop cleanup is incomplete/i,
  );
});

test('genuine cleanup-incomplete state remains fenced after the old owner and recorded membership die', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-stale-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'cleanup', ownerPid: 801, processes: { serverPid: 802 } });
  const stop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
  await finalizeStackRuntimeStop(statePath, {
    expected: stop.expected,
    cleanupResults: [{ ok: false, step: 'server' }],
  });

  await assert.rejects(
    () => recordStackRuntimeStart(statePath, {
      stackName: 'cleanup', ownerPid: process.pid, processes: { watcherPid: process.pid },
    }, {
      observePidLivenessImpl: async () => ({ status: 'dead', reason: 'not_found' }),
      isRuntimeProcessTrustedImpl: async () => true,
    }),
    (error) => error?.code === 'ESTACKRUNTIMECLEANUPINCOMPLETE',
  );
  assert.equal((await readStackRuntimeStateFile(statePath)).ownerPid, 801);
});

test('cleanup-incomplete state remains fenced when its recorded owner is absent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-ownerless-fence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeUpdate(statePath, {
    stackName: 'cleanup', ownerPid: null,
    stopRequest: { requestedAt: new Date().toISOString(), preserveDaemon: false },
  });
  await assert.rejects(
    () => recordStackRuntimeStart(statePath, { stackName: 'cleanup', ownerPid: process.pid }),
    (error) => error?.code === 'ESTACKRUNTIMECLEANUPINCOMPLETE',
  );
});

test('active cleanup fences direct recordStart from the same owner', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-same-owner-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'cleanup', ownerPid: process.pid, processes: { watcherPid: process.pid },
  }, { isRuntimeProcessTrustedImpl: async () => true });
  const stop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
  await finalizeStackRuntimeStop(statePath, {
    expected: stop.expected,
    cleanupResults: [{ ok: false, step: 'watcher' }],
  });

  await assert.rejects(
    () => recordStackRuntimeStart(statePath, {
      stackName: 'cleanup', ownerPid: process.pid,
    }, {
      observePidLivenessImpl: async () => ({ status: 'alive' }),
      isRuntimeProcessTrustedImpl: async () => true,
    }),
    (error) => error?.code === 'ESTACKRUNTIMECLEANUPINCOMPLETE',
  );
  assert.equal((await readStackRuntimeStateFile(statePath)).stopRequest?.preserveDaemon, false);
});

test('startup admission remains fail-closed for inconclusive owner liveness', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-inconclusive-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'cleanup', ownerPid: 801, processes: {} });
  await assert.rejects(
    () => recordStackRuntimeStart(statePath, { stackName: 'cleanup', ownerPid: process.pid }, {
      observePidLivenessImpl: async () => ({ status: 'inconclusive', reason: 'permission_denied' }),
    }),
    (error) => error?.code === 'ESTACKRUNTIMEOWNERINCONCLUSIVE',
  );
});

test('startup admission remains fail-closed for inconclusive recorded process liveness', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-inconclusive-member-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'cleanup', ownerPid: 801, processes: { serverPid: 802 } });
  await assert.rejects(
    () => recordStackRuntimeStart(statePath, { stackName: 'cleanup', ownerPid: process.pid }, {
      observePidLivenessImpl: async (pid) => pid === 801
        ? { status: 'dead', reason: 'not_found' }
        : { status: 'inconclusive', reason: 'probe_failed' },
    }),
    (error) => error?.code === 'ESTACKRUNTIMEPROCESSINCONCLUSIVE',
  );
});

test('expected-owner stop rejects a reused pid with a different lifecycle startedAt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-pid-reuse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'pid-reuse', ownerPid: process.pid, ports: {} });
  const first = await readStackRuntimeStateFile(statePath);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const successor = await recordStackRuntimeStart(statePath, { stackName: 'pid-reuse', ownerPid: process.pid, ports: {} });

  assert.notEqual(successor.startedAt, first.startedAt);
  const stop = await recordStackRuntimeStopRequest(statePath, {
    expectedOwnerPid: process.pid,
    expectedOwnerStartedAt: first.startedAt,
  });
  assert.equal(stop.authorized, false);
  assert.equal(stop.reason, 'successor_owner_incarnation');
  const retained = await readStackRuntimeStateFile(statePath);
  assert.equal(retained.ownerPid, successor.ownerPid);
  assert.equal(retained.startedAt, successor.startedAt);
  assert.equal(retained.stopRequest, null);
});

test('lifecycle startedAt remains strictly monotonic across three starts under a fixed wall clock', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-start-fixed-clock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  const RealDate = globalThis.Date;
  const fixedMs = RealDate.parse('2026-07-17T08:04:00.000Z');
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [fixedMs]));
    }

    static now() {
      return fixedMs;
    }
  }

  globalThis.Date = FixedDate;
  try {
    const first = await recordStackRuntimeStart(statePath, { stackName: 'fixed-clock', ownerPid: process.pid, ports: {} });
    const second = await recordStackRuntimeStart(statePath, { stackName: 'fixed-clock', ownerPid: process.pid, ports: {} });
    const third = await recordStackRuntimeStart(statePath, { stackName: 'fixed-clock', ownerPid: process.pid, ports: {} });

    assert.ok(RealDate.parse(first.startedAt) < RealDate.parse(second.startedAt));
    assert.ok(RealDate.parse(second.startedAt) < RealDate.parse(third.startedAt));
    assert.equal(new Set([first.startedAt, second.startedAt, third.startedAt]).size, 3);

    const staleStop = await recordStackRuntimeStopRequest(statePath, {
      expectedOwnerPid: process.pid,
      expectedOwnerStartedAt: first.startedAt,
    });
    assert.equal(staleStop.authorized, false);
    assert.equal(staleStop.reason, 'successor_owner_incarnation');
    assert.equal((await readStackRuntimeStateFile(statePath)).startedAt, third.startedAt);

    await recordStackRuntimeUpdate(statePath, { startedAt: '2026-07-17T08:04:00Z' });
    const afterNonCanonicalPersistence = await recordStackRuntimeStart(statePath, {
      stackName: 'fixed-clock',
      ownerPid: process.pid,
      ports: {},
    });
    assert.equal(afterNonCanonicalPersistence.startedAt, '2026-07-17T08:04:00.000Z');
  } finally {
    globalThis.Date = RealDate;
  }
});

test('expected-owner stop authorizes only canonical finite ISO lifecycle identities', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-incarnation-format-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  const runtime = await recordStackRuntimeStart(statePath, {
    stackName: 'incarnation-format',
    ownerPid: process.pid,
    ports: {},
  });

  for (const malformedExpected of ['not-a-timestamp', '2026-07-17T08:04:00Z', '+999999-01-01T00:00:00.000Z']) {
    const stop = await recordStackRuntimeStopRequest(statePath, {
      expectedOwnerPid: process.pid,
      expectedOwnerStartedAt: malformedExpected,
    });
    assert.equal(stop.authorized, false);
    assert.equal(stop.reason, 'invalid_expected_owner_incarnation');
    assert.equal((await readStackRuntimeStateFile(statePath)).stopRequest, null);
  }

  await recordStackRuntimeUpdate(statePath, { startedAt: 'not-a-timestamp' });
  const malformedPersisted = await recordStackRuntimeStopRequest(statePath, {
    expectedOwnerPid: process.pid,
    expectedOwnerStartedAt: runtime.startedAt,
  });
  assert.equal(malformedPersisted.authorized, false);
  assert.equal(malformedPersisted.reason, 'runtime_owner_incarnation_invalid');

  const matchingMalformed = await recordStackRuntimeStopRequest(statePath, {
    expectedOwnerPid: process.pid,
    expectedOwnerStartedAt: 'not-a-timestamp',
  });
  assert.equal(matchingMalformed.authorized, false);
  assert.equal(matchingMalformed.reason, 'invalid_expected_owner_incarnation');

  await recordStackRuntimeUpdate(statePath, { startedAt: runtime.startedAt });
  const valid = await recordStackRuntimeStopRequest(statePath, {
    expectedOwnerPid: process.pid,
    expectedOwnerStartedAt: runtime.startedAt,
  });
  assert.equal(valid.authorized, true);
  assert.equal(valid.reason, 'authorized');
});

test('expected-owner stop fails closed when its lifecycle startedAt is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-missing-incarnation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  const runtime = await recordStackRuntimeStart(statePath, { stackName: 'missing-incarnation', ownerPid: process.pid, ports: {} });

  const stop = await recordStackRuntimeStopRequest(statePath, { expectedOwnerPid: process.pid });
  assert.equal(stop.authorized, false);
  assert.equal(stop.reason, 'invalid_expected_owner_incarnation');
  assert.equal((await readStackRuntimeStateFile(statePath)).startedAt, runtime.startedAt);

  await recordStackRuntimeUpdate(statePath, { startedAt: null });
  const legacyStop = await recordStackRuntimeStopRequest(statePath, {
    expectedOwnerPid: process.pid,
    expectedOwnerStartedAt: runtime.startedAt,
  });
  assert.equal(legacyStop.authorized, false);
  assert.equal(legacyStop.reason, 'runtime_owner_incarnation_missing');
  assert.equal((await readStackRuntimeStateFile(statePath)).stopRequest, null);
});

test('stop finalization deletes matching state after owner exit and preserves selected daemon identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stop-preserve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  const runtime = await recordStackRuntimeStart(statePath, { stackName: 'race', ownerPid: 701, processes: { serverPid: 702, daemonPid: 703, daemonPids: [703] }, daemon: { distClosureFingerprint: 'fingerprint-703' } });
  const preserveStop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: true });
  assert.equal(preserveStop.expected.startedAt, runtime.startedAt);
  const preserved = await finalizeStackRuntimeStop(statePath, { expected: preserveStop.expected, preserveDaemon: true });
  assert.equal(preserved.finalized, true);
  const state = await readStackRuntimeStateFile(statePath);
  assert.equal(state.ownerPid, null);
  assert.deepEqual(state.processes, { daemonPid: 703, daemonPids: [703] });
  assert.equal(state.daemon.distClosureFingerprint, 'fingerprint-703');
  const deleteStop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
  await recordStackRuntimeUpdate(statePath, { processes: { daemonPid: null, daemonPids: [] }, daemon: { distClosureFingerprint: null } });
  const deleted = await finalizeStackRuntimeStop(statePath, { expected: deleteStop.expected, preserveDaemon: false });
  assert.equal(deleted.finalized, true);
  assert.equal(await readStackRuntimeStateFile(statePath), null);
});

for (const mode of ['direct', 'proxy', 'directFallback']) {
  test(`server ${mode} activation publishes complete truth and preserves authoritative attention on failure`, async () => {
    const activation = {
      listenerPid: 301,
      wrapperPid: 201,
      stablePort: 4101,
      backendPort: mode === 'proxy' ? 5101 : null,
      proxyPid: mode === 'proxy' ? 401 : null,
      mode,
      fallbackReason: mode === 'directFallback' ? 'proxy unavailable' : null,
    };
    let publishedPatch = null;

    assert.equal(typeof runtimeStateModule.recordStackRuntimeServerActivation, 'function');
    await runtimeStateModule.recordStackRuntimeServerActivation(
      '/tmp/stack.runtime.json',
      activation,
      {
        recordStackRuntimeUpdateImpl: async (_statePath, patch) => {
          publishedPatch = patch;
        },
      },
    );

    assert.equal(publishedPatch?.processes?.serverPid, 301);
    assert.equal(publishedPatch?.processes?.serverWrapperPid, 201);
    assert.equal(publishedPatch?.processes?.proxyPid, mode === 'proxy' ? 401 : null);
    assert.equal(publishedPatch?.processes?.serverBackendPid, mode === 'proxy' ? 301 : null);
    assert.equal(publishedPatch?.processes?.serverDrainingPid, null);
    assert.equal(publishedPatch?.ports?.server, 4101);
    assert.equal(publishedPatch?.ports?.serverBackend, mode === 'proxy' ? 5101 : null);
    assert.equal(publishedPatch?.serverProxy?.mode, mode);
    assert.equal(publishedPatch?.serverProxy?.fallbackReason, mode === 'directFallback' ? 'proxy unavailable' : null);

    await assert.rejects(
      () => runtimeStateModule.recordStackRuntimeServerActivation(
        '/tmp/stack.runtime.json',
        activation,
        {
          recordStackRuntimeUpdateImpl: async () => {
            throw new Error('runtime publication unavailable');
          },
        },
      ),
      (error) => error?.code === 'ESERVERRUNTIMEPROJECTION'
        && error?.serverActivationCommitted === true
        && error?.authoritativeServerPid === 301
        && error?.authoritativeServerWrapperPid === 201
        && error?.serverMode === mode
        && /runtime publication unavailable/.test(error.message),
    );
  });
}

test('server reload activation atomically publishes process, proxy, port, and completed lifecycle truth', async () => {
  let publishedPatch = null;

  assert.equal(typeof runtimeStateModule.recordStackRuntimeServerActivation, 'function');
  await runtimeStateModule.recordStackRuntimeServerActivation(
    '/tmp/stack.runtime.json',
    {
      listenerPid: 302,
      wrapperPid: 202,
      stablePort: 4101,
      backendPort: 5102,
      proxyPid: 402,
      drainingPid: 301,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
      reloadGeneration: 17,
    },
    {
      recordStackRuntimeUpdateImpl: async (_statePath, patch) => {
        publishedPatch = patch;
      },
    },
  );

  assert.deepEqual(publishedPatch, {
    processes: {
      serverPid: 302,
      serverWrapperPid: 202,
      proxyPid: 402,
      serverBackendPid: 302,
      serverDrainingPid: 301,
    },
    ports: {
      server: 4101,
      serverBackend: 5102,
    },
    serverProxy: {
      enabled: true,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
      reloadGeneration: 17,
      fallbackReason: null,
    },
    serverLifecycle: {
      phase: 'completed',
      planned: null,
      lastCompleted: { mode: 'exclusiveDb', generation: 17 },
      retry: null,
      disposition: null,
    },
  });
});

for (const role of ['managed-backend', 'managed-gateway']) {
  test(`managed full-server ${role} activation publishes complete truth and committed failure attention`, async () => {
    const managedBackendPid = 501;
    const managedGatewayPid = role === 'managed-gateway' ? 601 : null;
    const activation = {
      stablePort: 4101,
      backendPort: 5101,
      managedBackendPid,
      managedGatewayPid,
      mode: role,
    };
    let publishedPatch = null;

    assert.equal(typeof runtimeStateModule.recordStackRuntimeServerActivation, 'function');
    await runtimeStateModule.recordStackRuntimeServerActivation(
      '/tmp/stack.runtime.json',
      activation,
      {
        recordStackRuntimeUpdateImpl: async (_statePath, patch) => {
          publishedPatch = patch;
        },
      },
    );

    const authoritativePid = role === 'managed-backend' ? managedBackendPid : managedGatewayPid;
    assert.deepEqual(publishedPatch, {
      processes: {
        serverPid: authoritativePid,
        serverWrapperPid: authoritativePid,
        proxyPid: null,
        serverBackendPid: null,
        serverDrainingPid: null,
        happierServerBackendPid: managedBackendPid,
        uiGatewayPid: managedGatewayPid,
      },
      ports: {
        server: 4101,
        serverBackend: null,
        backend: 5101,
      },
      serverProxy: {
        enabled: false,
        mode: role,
        restartMode: null,
        reloadGeneration: null,
        fallbackReason: null,
      },
    });

    await assert.rejects(
      () => runtimeStateModule.recordStackRuntimeServerActivation(
        '/tmp/stack.runtime.json',
        activation,
        {
          recordStackRuntimeUpdateImpl: async () => {
            throw new Error('runtime publication unavailable');
          },
        },
      ),
      (error) => error?.code === 'ESERVERRUNTIMEPROJECTION'
        && error?.serverActivationCommitted === true
        && error?.authoritativeProcessPid === authoritativePid
        && error?.authoritativeProcessRole === role,
    );
  });
}

test('server activation preserves an already-annotated committed projection failure', async () => {
  const committedFailure = new Error('runtime publication unavailable');
  committedFailure.code = 'ESERVERRUNTIMEPROJECTION';
  committedFailure.serverActivationCommitted = true;

  await assert.rejects(
    () => runtimeStateModule.recordStackRuntimeServerActivation(
      '/tmp/stack.runtime.json',
      { listenerPid: 301, wrapperPid: 201, stablePort: 4101, mode: 'direct' },
      { recordStackRuntimeUpdateImpl: async () => { throw committedFailure; } },
    ),
    (error) => error === committedFailure,
  );
});

test('server lifecycle projection starts idle, preserves completion across attempts, and clears stale attempt fields', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-lifecycle-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const statePath = join(dir, 'stack.runtime.json');

  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'dev.mjs',
    ephemeral: false,
    ownerPid: process.pid,
    serverLifecycle: {
      phase: 'completed',
      planned: null,
      lastCompleted: { mode: 'exclusiveDb', generation: 99 },
      retry: null,
      disposition: null,
    },
  });
  const runtimeState = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(runtimeState.serverLifecycle, {
    phase: 'idle',
    planned: null,
    lastCompleted: null,
    retry: null,
    disposition: null,
  });

  await recordStackRuntimeServerLifecycle(statePath, {
    phase: 'completed',
    lastCompleted: { mode: 'exclusiveDb', generation: 3 },
  });
  await recordStackRuntimeServerLifecycle(statePath, {
    phase: 'retry-scheduled',
    plan: { mode: 'exclusiveDb', generation: 4, reason: 'prisma_changed' },
    retryAfterMs: 250,
  });
  await recordStackRuntimeServerLifecycle(statePath, {
    phase: 'blocked',
    plan: { mode: 'exclusiveDb', generation: 4, reason: 'prisma_changed' },
    disposition: { code: 'readiness_failed' },
  });

  assert.deepEqual((await readStackRuntimeStateFile(statePath)).serverLifecycle, {
    phase: 'blocked',
    planned: { mode: 'exclusiveDb', generation: 4, reason: 'prisma_changed' },
    lastCompleted: { mode: 'exclusiveDb', generation: 3 },
    retry: null,
    disposition: { code: 'readiness_failed' },
  });
});

test('terminal unavailable lifecycle atomically clears stale server membership and preserves stack ownership', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-unavailable-'));
  const statePath = join(dir, 'stack.runtime.json');
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    ownerPid: process.pid,
    processes: { daemonPid: process.pid, daemonPids: [process.pid] },
  });
  await runtimeStateModule.recordStackRuntimeServerActivation(statePath, {
    listenerPid: process.pid,
    wrapperPid: process.pid,
    stablePort: 4101,
    backendPort: 5101,
    proxyPid: process.pid,
    drainingPid: process.pid,
    mode: 'proxy',
    restartMode: 'exclusiveDb',
    reloadGeneration: 4,
  });

  const patches = [];
  await recordStackRuntimeServerLifecycle(statePath, {
    phase: 'unavailable',
    plan: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
    disposition: { code: 'recovery_failed' },
  }, {
    recordStackRuntimeUpdateImpl: async (path, patch) => {
      patches.push(patch);
      return await recordStackRuntimeUpdate(path, patch);
    },
  });

  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].processes, {
    serverPid: null,
    serverWrapperPid: null,
    serverBackendPid: null,
    serverDrainingPid: null,
  });
  assert.deepEqual(patches[0].ports, { serverBackend: null });

  const runtimeState = await readStackRuntimeStateFile(statePath);
  assert.equal(runtimeState.ownerPid, process.pid);
  assert.equal(runtimeState.processes.proxyPid, process.pid);
  assert.equal(runtimeState.processes.daemonPid, process.pid);
  assert.deepEqual(runtimeState.processes.daemonPids, [process.pid]);
  assert.equal(runtimeState.ports.server, 4101);
  assert.equal(runtimeState.ports.serverBackend, null);
  assert.equal(runtimeState.serverProxy.mode, 'proxy');
  assert.equal(runtimeState.processes.serverPid, null);
  assert.equal(runtimeState.processes.serverWrapperPid, null);
  assert.equal(runtimeState.processes.serverBackendPid, null);
  assert.equal(runtimeState.processes.serverDrainingPid, null);
  assert.deepEqual(runtimeState.serverLifecycle, {
    phase: 'unavailable',
    planned: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
    lastCompleted: { mode: 'exclusiveDb', generation: 4 },
    retry: null,
    disposition: { code: 'recovery_failed' },
  });
});

test('server lifecycle reader treats absent and malformed additive state as unknown', () => {
  assert.equal(readStackServerLifecycle({ serverProxy: { restartMode: 'exclusiveDb' } }), null);
  assert.equal(readStackServerLifecycle({ serverLifecycle: { phase: 'completed' } }), null);
  assert.equal(readStackServerLifecycle({
    serverLifecycle: {
      phase: 'completed',
      planned: null,
      lastCompleted: { mode: 'exclusiveDb', generation: '3' },
      retry: null,
      disposition: null,
    },
  }), null);
});

test('recordStackRuntimeStart refreshes startedAt when a dead owner is replaced', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  const first = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid + 100000,
    ports: { server: 23456 },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  assert.notEqual(second.startedAt, first.startedAt);
});

test('recordStackRuntimeStart refuses to overwrite a different live lifecycle owner', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-live-owner-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  const first = await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'dev.mjs',
    ephemeral: false,
    ownerPid: process.pid,
    ports: { server: 23456 },
    processes: { proxyPid: process.pid, watcherPid: process.pid },
  }, {
    isRuntimeProcessTrustedImpl: async () => true,
  });

  await assert.rejects(
    () => recordStackRuntimeStart(statePath, {
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: false,
      ownerPid: process.pid + 100000,
      ports: {},
    }),
    /already has a live lifecycle owner/,
  );

  assert.deepEqual(await readStackRuntimeStateFile(statePath), first);
});

test('recordStackRuntimeUpdate serializes concurrent patches without losing sibling fields', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-concurrent-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  const writerCount = 32;
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await Promise.all(
    Array.from({ length: writerCount }, (_, index) =>
      recordStackRuntimeUpdate(statePath, {
        concurrentWriters: { [`writer${index}`]: index },
      }),
    ),
  );

  const state = await readStackRuntimeStateFile(statePath);
  assert.equal(Object.keys(state?.concurrentWriters ?? {}).length, writerCount);
  for (let index = 0; index < writerCount; index += 1) {
    assert.equal(state?.concurrentWriters?.[`writer${index}`], index);
  }
});

test('recordStackRuntimeServerPids stores listener and wrapper pids distinctly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-server-pids-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await recordStackRuntimeServerPids(statePath, { listenerPid: 301, wrapperPid: 201 });

  const state = await readStackRuntimeStateFile(statePath);
  assert.equal(state?.processes?.serverPid, 301);
  assert.equal(state?.processes?.serverWrapperPid, 201);
});

test('recordStackRuntimeServerPids surfaces committed server attention when publication fails', async () => {
  await assert.rejects(
    () => recordStackRuntimeServerPids(
      '/tmp/stack.runtime.json',
      { listenerPid: 301, wrapperPid: null },
      {
        recordStackRuntimeUpdateImpl: async () => {
          throw new Error('runtime publication unavailable');
        },
      },
    ),
    (error) => error?.code === 'ESERVERRUNTIMEPROJECTION'
      && error?.serverActivationCommitted === true
      && error?.authoritativeServerPid === 301
      && /runtime publication unavailable/.test(error.message),
  );
});

test('createStackServerRuntimeProcessPatch can clear stale dev proxy metadata for direct mode', () => {
  assert.deepEqual(
    createStackServerRuntimeProcessPatch({
      listenerPid: 301,
      wrapperPid: 201,
      serverPort: 4101,
      clearProxyState: true,
    }),
    {
      processes: {
        serverPid: 301,
        serverWrapperPid: 201,
        proxyPid: null,
        serverBackendPid: null,
        serverDrainingPid: null,
      },
      ports: {
        server: 4101,
        serverBackend: null,
      },
      serverProxy: {
        enabled: false,
        mode: 'direct',
        restartMode: null,
        reloadGeneration: null,
        fallbackReason: null,
      },
    },
  );
});

test('createStackDevProxyRuntimePatch records stable and backend proxy state', () => {
  assert.deepEqual(
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5102,
      proxyPid: process.pid,
      backendPid: 302,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
    }),
    {
      processes: {
        proxyPid: process.pid,
        serverBackendPid: 302,
        serverDrainingPid: null,
      },
      ports: {
        server: 4101,
        serverBackend: 5102,
      },
      serverProxy: {
        enabled: true,
        mode: 'proxy',
        restartMode: 'exclusiveDb',
        reloadGeneration: null,
        fallbackReason: null,
      },
    },
  );
});

test('dev proxy runtime patch clears mode-specific metadata across deep merge', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-proxy-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'dev.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 4101 },
  });

  await recordStackRuntimeUpdate(
    statePath,
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5102,
      proxyPid: process.pid,
      backendPid: process.pid + 1,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
    }),
  );
  await recordStackRuntimeUpdate(
    statePath,
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: null,
      proxyPid: null,
      backendPid: null,
      drainingPid: null,
      mode: 'directFallback',
      fallbackReason: 'proxy bind failed',
    }),
  );

  const state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.serverProxy, {
    enabled: true,
    mode: 'directFallback',
    restartMode: null,
    reloadGeneration: null,
    fallbackReason: 'proxy bind failed',
  });
});

test('recordStackRuntimeStart clears dead process pids while preserving live child pids', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-pids-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: 999_999_998,
      ports: { server: 23456 },
      processes: {
        serverPid: 999_999_997,
        daemonPid: process.pid,
      },
    }) + '\n',
    'utf8',
  );

  const next = await recordStackRuntimeStart(
    statePath,
    {
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: process.pid,
      ports: { server: 23456 },
    },
    {
      isRuntimeProcessTrustedImpl: async () => true,
    },
  );

  assert.equal(next.processes.serverPid, null);
  assert.equal(next.processes.daemonPid, process.pid);
});

test('recordStackRuntimeStart clears live process pids that fail stack ownership validation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-reused-pids-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: 999_999_998,
      ports: { server: 23456 },
      processes: {
        serverPid: process.pid,
        daemonPid: process.pid,
      },
    }) + '\n',
    'utf8',
  );

  const next = await recordStackRuntimeStart(
    statePath,
    {
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: process.pid,
      ports: { server: 23456 },
    },
    {
      isPidAliveImpl: () => true,
      isRuntimeProcessTrustedImpl: async (_pid, { key }) => key === 'daemonPid',
    },
  );

  assert.equal(next.processes.serverPid, null);
  assert.equal(next.processes.daemonPid, process.pid);
});

test('getStackRuntimeProcessEntries includes pid set arrays without duplicate or invalid pids', () => {
  const entries = getStackRuntimeProcessEntries({
    processes: {
      serverPid: 123,
      daemonPid: 222,
      daemonPids: [222, '333', 0, 'nope', 333],
      unrelated: 444,
      invalidPids: ['x', 1],
    },
  });

  assert.deepEqual(entries, [
    { key: 'serverPid', pid: 123 },
    { key: 'daemonPid', pid: 222 },
    { key: 'daemonPids', pid: 222 },
    { key: 'daemonPids', pid: 333 },
  ]);
});

test('recordStackRuntimeStart prunes untrusted pid set entries while preserving trusted entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-pid-sets-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: 999_999_998,
      ports: { server: 23456 },
      processes: {
        daemonPids: [process.pid, process.pid + 100000],
      },
    }) + '\n',
    'utf8',
  );

  const next = await recordStackRuntimeStart(
    statePath,
    {
      stackName: 'dev-built',
      script: 'dev.mjs',
      ephemeral: true,
      ownerPid: process.pid,
      ports: { server: 23456 },
    },
    {
      isPidAliveImpl: (pid) => Number(pid) === process.pid,
      isRuntimeProcessTrustedImpl: async (_pid, { key }) => key === 'daemonPids',
    },
  );

  assert.deepEqual(next.processes.daemonPids, [process.pid]);
});

test('resolveTrustedStackRuntimeServerPort rejects live runtime pids without stack ownership evidence', async () => {
  const port = await resolveTrustedStackRuntimeServerPort(
    {
      ownerPid: process.pid,
      processes: { serverPid: process.pid },
      ports: { server: 23456 },
    },
    { stackName: 'dev-built' },
    {
      isPidAliveImpl: () => true,
      isRuntimeProcessTrustedImpl: async () => false,
    },
  );

  assert.equal(port, null);
});

test('resolveTrustedStackRuntimeServerPort accepts a live trusted runtime component pid', async () => {
  const port = await resolveTrustedStackRuntimeServerPort(
    {
      ownerPid: 999_999_998,
      processes: { serverPid: process.pid },
      ports: { server: 23456 },
    },
    { stackName: 'dev-built' },
    {
      isPidAliveImpl: (pid) => Number(pid) === process.pid,
      isRuntimeProcessTrustedImpl: async (_pid, { key }) => key === 'serverPid',
    },
  );

  assert.equal(port, 23456);
});

test('recordStackRuntimeStopRequest persists stop attribution details', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, {
    stackName: 'dev-built',
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: process.pid,
    ports: { server: 23456 },
  });

  await recordStackRuntimeStopRequest(statePath, {
    signal: 'SIGTERM',
    requestedBy: 'service restart',
    reason: 'explicit restart',
    preserveDaemon: true,
  });

  const state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.stopRequest, {
    signal: 'SIGTERM',
    requestedBy: 'service restart',
    reason: 'explicit restart',
    preserveDaemon: true,
    requestedAt: state?.stopRequest?.requestedAt,
  });
  assert.equal(typeof state?.stopRequest?.requestedAt, 'string');
});
