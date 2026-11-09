import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createStackDevProxyRuntimePatch,
  createStackServerRuntimeProcessPatch,
  readStackRuntimeStateFile,
  readStackServerLifecycle,
  recordStackRuntimeServerLifecycle,
  recordStackRuntimeServerActivation,
  recordStackRuntimeExpoPublication,
  recordStackRuntimeStart,
  recordStackRuntimeUpdate,
  restoreStackRuntimeExpoPublication,
  withStackRuntimeStartClaim,
  recordStackRuntimeServerPids,
  recordStackRuntimeStopRequest,
  captureStackRuntimeStopSnapshot,
  deleteStackRuntimeStateIfOwnedBy,
  finalizeStackRuntimeStop,
  withStackRuntimeStopTransaction,
} from './runtime_state.mjs';

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
  await recordStackRuntimeStart(statePath, {
    stackName: 'race', ownerPid: 501, processes: { serverPid: 601 },
    serverProxy: { reloadGeneration: 1 },
  });
  const stop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
  await recordStackRuntimeUpdate(statePath, {
    ownerPid: 501,
    processes: { serverPid: 602 },
    serverProxy: { reloadGeneration: 2 },
  });
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
  });
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
  const runtime = await recordStackRuntimeStart(statePath, {
    stackName: 'race', ownerPid: 701,
    processes: { serverPid: 702, daemonPid: 703, daemonPids: [703] },
    daemon: { distClosureFingerprint: 'fingerprint-703' },
  });
  const preserveStop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: true });
  assert.equal(preserveStop.expected.startedAt, runtime.startedAt);
  const preserved = await finalizeStackRuntimeStop(statePath, { expected: preserveStop.expected, preserveDaemon: true });
  assert.equal(preserved.finalized, true);
  const state = await readStackRuntimeStateFile(statePath);
  assert.equal(state.ownerPid, null);
  assert.deepEqual(state.processes, { daemonPid: 703, daemonPids: [703] });
  assert.equal(state.daemon.distClosureFingerprint, 'fingerprint-703');

  const deleteStop = await recordStackRuntimeStopRequest(statePath, { preserveDaemon: false });
  await recordStackRuntimeUpdate(statePath, {
    processes: { daemonPid: null, daemonPids: [] },
    daemon: { distClosureFingerprint: null },
  });
  const deleted = await finalizeStackRuntimeStop(statePath, { expected: deleteStop.expected, preserveDaemon: false });
  assert.equal(deleted.finalized, true);
  assert.equal(await readStackRuntimeStateFile(statePath), null);
});

for (const mode of ['direct', 'proxy', 'directFallback']) {
  test(`server ${mode} activation publication preserves authoritative process attention on failure`, async () => {
    await assert.rejects(
      () => recordStackRuntimeServerActivation(
        '/tmp/stack.runtime.json',
        {
          listenerPid: 301,
          wrapperPid: 201,
          stablePort: 4101,
          backendPort: mode === 'proxy' ? 5101 : null,
          proxyPid: mode === 'proxy' ? 401 : null,
          mode,
          fallbackReason: mode === 'directFallback' ? 'proxy unavailable' : null,
        },
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

test('server reload activation projects reload and draining state before surfacing committed publication failure', async () => {
  let publishedPatch = null;
  await assert.rejects(
    () => recordStackRuntimeServerActivation(
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
          throw new Error('runtime publication unavailable');
        },
      },
    ),
    (error) => error?.code === 'ESERVERRUNTIMEPROJECTION'
      && error?.serverActivationCommitted === true
      && error?.authoritativeServerPid === 302
      && error?.authoritativeServerWrapperPid === 202
      && error?.serverMode === 'proxy'
      && /runtime publication unavailable/.test(error.message),
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

test('server lifecycle projections clear stale transition fields while preserving last completed activation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-server-lifecycle-'));
  const statePath = join(dir, 'stack.runtime.json');
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await recordStackRuntimeStart(statePath, { stackName: 'test', ownerPid: process.pid });
  assert.deepEqual((await readStackRuntimeStateFile(statePath)).serverLifecycle, {
    phase: 'idle',
    planned: null,
    lastCompleted: null,
    retry: null,
    disposition: null,
  });
  await recordStackRuntimeServerActivation(statePath, {
    listenerPid: 301,
    wrapperPid: 201,
    stablePort: 4101,
    mode: 'direct',
    restartMode: 'exclusiveDb',
    reloadGeneration: 4,
  });
  await recordStackRuntimeServerLifecycle(statePath, {
    phase: 'retry-scheduled',
    plan: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
    retryAfterMs: 250,
  });
  await recordStackRuntimeServerLifecycle(statePath, {
    phase: 'blocked',
    plan: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
    disposition: { code: 'readiness_failed' },
  });

  assert.deepEqual((await readStackRuntimeStateFile(statePath)).serverLifecycle, {
    phase: 'blocked',
    planned: { mode: 'exclusiveDb', generation: 5, reason: 'prisma_changed' },
    lastCompleted: { mode: 'exclusiveDb', generation: 4 },
    retry: null,
    disposition: { code: 'readiness_failed' },
  });
});

test('terminal unavailable lifecycle atomically clears stale server membership and preserves stack ownership', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-server-unavailable-'));
  const statePath = join(dir, 'stack.runtime.json');
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await recordStackRuntimeStart(statePath, {
    stackName: 'test',
    ownerPid: process.pid,
    processes: { daemonPid: process.pid, daemonPids: [process.pid] },
  });
  await recordStackRuntimeServerActivation(statePath, {
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

test('activation ambiguity preserves committed reload mirrors and last-completed lifecycle truth', async () => {
  let publishedPatch = null;
  await recordStackRuntimeServerActivation('/tmp/stack.runtime.json', {
    listenerPid: null,
    wrapperPid: null,
    stablePort: 4101,
    backendPort: 5101,
    proxyPid: 91,
    drainingPid: 302,
    mode: 'proxy',
    restartMode: 'exclusiveDb',
    reloadGeneration: 9,
    preserveReloadCompletion: true,
  }, {
    recordStackRuntimeUpdateImpl: async (_statePath, patch) => { publishedPatch = patch; },
  });

  assert.equal(Object.hasOwn(publishedPatch, 'serverLifecycle'), false);
  assert.equal(Object.hasOwn(publishedPatch.serverProxy, 'restartMode'), false);
  assert.equal(Object.hasOwn(publishedPatch.serverProxy, 'reloadGeneration'), false);
});

test('server lifecycle readers treat absent or malformed additive state as unknown without inferring from mirrors', () => {
  assert.equal(readStackServerLifecycle({ serverProxy: { restartMode: 'exclusiveDb', reloadGeneration: 9 } }), null);
  assert.equal(readStackServerLifecycle({ serverLifecycle: { phase: 'completed' } }), null);
  assert.equal(readStackServerLifecycle({
    serverLifecycle: {
      phase: 'completed',
      planned: null,
      lastCompleted: { mode: 'exclusiveDb', generation: '9' },
      retry: null,
      disposition: null,
    },
  }), null);
  assert.equal(readStackServerLifecycle({
    serverLifecycle: {
      phase: 'completed',
      planned: null,
      lastCompleted: { mode: 'exclusiveDb', generation: 9 },
      retry: { afterMs: 250 },
      disposition: null,
    },
  }), null);
});

test('recordStackRuntimeServerPids uses the typed activation publication contract', async () => {
  await assert.rejects(
    () => recordStackRuntimeServerPids(
      '/tmp/stack.runtime.json',
      { listenerPid: 301, wrapperPid: null, serverPort: 4101, clearProxyState: true },
      { recordStackRuntimeUpdateImpl: async () => { throw new Error('runtime publication unavailable'); } },
    ),
    (error) => error?.code === 'ESERVERRUNTIMEPROJECTION'
      && error?.serverActivationCommitted === true
      && error?.authoritativeServerPid === 301,
  );
});

for (const role of ['managed-backend', 'managed-gateway']) {
  test(`managed full-server ${role} publication synthesizes complete activation truth and authoritative attention`, async () => {
    const managedBackendPid = 501;
    const managedGatewayPid = role === 'managed-gateway' ? 601 : null;
    let publishedPatch = null;
    const activation = {
      stablePort: 4101,
      backendPort: 5101,
      managedBackendPid,
      managedGatewayPid,
      mode: role,
    };

    await recordStackRuntimeServerActivation(
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
      () => recordStackRuntimeServerActivation(
        '/tmp/stack.runtime.json',
        activation,
        {
          recordStackRuntimeUpdateImpl: async () => { throw new Error('runtime publication unavailable'); },
        },
      ),
      (error) => error?.code === 'ESERVERRUNTIMEPROJECTION'
        && error?.serverActivationCommitted === true
        && error?.authoritativeProcessPid === authoritativePid
        && error?.authoritativeProcessRole === role,
    );
  });
}

test('Expo publication CAS and rollback preserve concurrent non-Expo runtime fields', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-expo-publication-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');

  await recordStackRuntimeUpdate(statePath, {
    processes: { serverPid: 101, expoPid: 201 },
    expo: { port: 8081, publicationGeneration: 1, publicationToken: 'prior' },
  });
  const prior = await readStackRuntimeStateFile(statePath);
  await recordStackRuntimeExpoPublication(statePath, {
    generation: 2,
    publicationToken: 'current',
    expectedPreviousToken: 'prior',
    processes: { expoPid: 202, expoTailscaleForwarderPid: 302 },
    expo: { port: 8082 },
  });
  await recordStackRuntimeUpdate(statePath, { processes: { serverPid: 102 } });

  await assert.rejects(
    () => recordStackRuntimeExpoPublication(statePath, {
      generation: 2,
      publicationToken: 'stale',
      expectedPreviousToken: 'prior',
      processes: { expoPid: 203 },
      expo: { port: 8083 },
    }),
    (error) => error?.code === 'EEXPORUNTIMEGENERATION',
  );
  assert.equal(await restoreStackRuntimeExpoPublication(statePath, {
    publicationToken: 'current',
    priorExpo: prior.expo,
    priorProcesses: prior.processes,
  }), true);

  const restored = await readStackRuntimeStateFile(statePath);
  assert.equal(restored.processes.serverPid, 102);
  assert.equal(restored.processes.expoPid, 201);
  assert.equal(Object.hasOwn(restored.processes, 'expoTailscaleForwarderPid'), false);
  assert.deepEqual(restored.expo, prior.expo);
});

test('withStackRuntimeStartClaim serializes empty-state contenders before spawn', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-claim-race-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'stack.runtime.json');
  let spawnCount = 0;

  const start = (ownerPid) => withStackRuntimeStartClaim(statePath, { stackName: 'race' }, async ({ recordStart }) => {
    spawnCount += 1;
    await recordStart({
      stackName: 'race',
      script: 'dev.mjs',
      ownerPid,
      ports: { server: 4101 },
    });
    return ownerPid;
  });

  const results = await Promise.allSettled([start(process.pid), start(process.pid + 100000)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(spawnCount, 1);
  assert.equal((await readStackRuntimeStateFile(statePath)).ownerPid, process.pid);
});

test('recordStackRuntimeStart refreshes startedAt when the owner pid changes', async (t) => {
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

test('recordStackRuntimeServerPids stores listener and wrapper pids distinctly', async (t) => {
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

  await recordStackRuntimeServerPids(statePath, { listenerPid: 301, wrapperPid: 201 });

  const state = await readStackRuntimeStateFile(statePath);
  assert.equal(state?.processes?.serverPid, 301);
  assert.equal(state?.processes?.serverWrapperPid, 201);
});

test('createStackServerRuntimeProcessPatch clears invalid wrapper pid without clearing listener pid', () => {
  assert.deepEqual(createStackServerRuntimeProcessPatch({ listenerPid: 301, wrapperPid: null }), {
    processes: { serverPid: 301, serverWrapperPid: null },
  });
});

test('createStackServerRuntimeProcessPatch can clear proxy metadata when recording direct mode', () => {
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

test('createStackDevProxyRuntimePatch records stable and backend proxy state without gateway backend fields', () => {
  assert.deepEqual(
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5102,
      proxyPid: process.pid,
      backendPid: 302,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
      reloadGeneration: 4,
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
        reloadGeneration: 4,
        fallbackReason: null,
      },
    }
  );
});

test('stack dev proxy runtime patch clears stale mode-specific metadata across deep merge', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-runtime-state-'));
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

  let state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.serverProxy, {
    enabled: true,
    mode: 'directFallback',
    restartMode: null,
    reloadGeneration: null,
    fallbackReason: 'proxy bind failed',
  });

  await recordStackRuntimeUpdate(
    statePath,
    createStackDevProxyRuntimePatch({
      stablePort: 4101,
      backendPort: 5103,
      proxyPid: process.pid,
      backendPid: process.pid + 2,
      drainingPid: null,
      mode: 'proxy',
      restartMode: 'exclusiveDb',
    }),
  );

  state = await readStackRuntimeStateFile(statePath);
  assert.deepEqual(state?.serverProxy, {
    enabled: true,
    mode: 'proxy',
    restartMode: 'exclusiveDb',
    reloadGeneration: null,
    fallbackReason: null,
  });
});

test('a verified server identity is recorded as proven and is not re-read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-verified-'));
  try {
    const statePath = join(dir, 'stack.runtime.json');
    // No live process has these PIDs, so a re-read could only lose the verified identity.
    const verifiedProcessInstances = {
      serverPid: { pid: 2147480001, fingerprint: 'win32-cim:listener' },
      serverWrapperPid: { pid: 2147480002, fingerprint: 'win32-cim:wrapper' },
    };
    await recordStackRuntimeServerActivation(statePath, {
      listenerPid: 2147480001,
      wrapperPid: 2147480002,
      stablePort: 53944,
      backendPort: 53945,
      proxyPid: null,
      mode: 'proxy',
      verifiedProcessInstances,
    });

    const state = await readStackRuntimeStateFile(statePath);
    assert.deepEqual(state.processInstances.processes.serverPid, verifiedProcessInstances.serverPid);
    assert.deepEqual(state.processInstances.processes.serverWrapperPid, verifiedProcessInstances.serverWrapperPid);
    assert.deepEqual(state.processInstances.processes.serverBackendPid, verifiedProcessInstances.serverPid);
    assert.equal('verifiedProcessInstances' in state, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordStackRuntimeServerPids forwards a verified identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-verified-'));
  try {
    const statePath = join(dir, 'stack.runtime.json');
    const serverPid = { pid: 2147480003, fingerprint: 'win32-cim:listener' };
    await recordStackRuntimeServerPids(statePath, {
      listenerPid: serverPid.pid,
      wrapperPid: serverPid.pid,
      serverPort: 53944,
      clearProxyState: true,
      verifiedProcessInstances: { serverPid, serverWrapperPid: serverPid },
    });
    const state = await readStackRuntimeStateFile(statePath);
    assert.deepEqual(state.processInstances.processes.serverPid, serverPid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unverified process stays unverified across later writes and is never recaptured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-unverified-'));
  try {
    const statePath = join(dir, 'stack.runtime.json');
    // A live PID: any recapture would find a real identity here.
    await recordStackRuntimeUpdate(statePath, {
      processes: { serverDrainingPid: process.pid },
      unverifiedProcessPids: [process.pid],
    });
    await recordStackRuntimeUpdate(statePath, { ports: { server: 53944 } });

    const state = await readStackRuntimeStateFile(statePath);
    assert.deepEqual(state.processInstances.processes.serverDrainingPid, {
      pid: process.pid,
      fingerprint: null,
      unverified: true,
    });
    assert.equal('unverifiedProcessPids' in state, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a recorded spawn identity survives later writes instead of being re-read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-spawn-identity-'));
  try {
    const statePath = join(dir, 'stack.runtime.json');
    const serverDrainingPid = { pid: process.pid, fingerprint: 'win32-cim:spawn-created' };
    await recordStackRuntimeUpdate(statePath, {
      processes: { serverDrainingPid: process.pid },
      verifiedProcessInstances: { serverDrainingPid },
    });
    await recordStackRuntimeUpdate(statePath, { ports: { server: 53944 } });

    const state = await readStackRuntimeStateFile(statePath);
    assert.deepEqual(state.processInstances.processes.serverDrainingPid, serverDrainingPid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createUnverifiedRuntimeState(dir, { pid = process.pid, ownerPid } = {}) {
  const statePath = join(dir, 'stack.runtime.json');
  await recordStackRuntimeUpdate(statePath, {
    stackName: 'unverified-test',
    ownerPid,
    processes: { serverDrainingPid: pid },
    unverifiedProcessPids: [pid],
  });
  return statePath;
}

const expectedUnverified = (pid = process.pid) => ({ pid, fingerprint: null, unverified: true });

test('a restart by the same owner keeps an unverified process unverified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-unverified-start-'));
  try {
    const statePath = await createUnverifiedRuntimeState(dir, { ownerPid: process.pid });
    const state = await recordStackRuntimeStart(statePath, {
      stackName: 'unverified-test',
      ownerPid: process.pid,
    });
    assert.equal(state.processes.serverDrainingPid, process.pid);
    assert.deepEqual(state.processInstances.processes.serverDrainingPid, expectedUnverified());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a successor owner keeps a live unverified process unverified without judging its ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-unverified-successor-'));
  try {
    const statePath = await createUnverifiedRuntimeState(dir, { ownerPid: 2147480300 });
    const state = await recordStackRuntimeStart(statePath, {
      stackName: 'unverified-test',
      ownerPid: process.pid,
    }, {
      observePidLivenessImpl: async (pid) => ({ status: pid === process.pid ? 'alive' : 'dead' }),
      isRuntimeProcessTrustedImpl: async () => assert.fail('a positive ownership answer would adopt the PID'),
    });
    assert.equal(state.processes.serverDrainingPid, process.pid);
    assert.deepEqual(state.processInstances.processes.serverDrainingPid, expectedUnverified());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a successor owner drops an unverified process that is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-unverified-gone-'));
  try {
    const statePath = await createUnverifiedRuntimeState(dir, { pid: 2147480301, ownerPid: 2147480300 });
    const state = await recordStackRuntimeStart(statePath, {
      stackName: 'unverified-test',
      ownerPid: process.pid,
    }, {
      observePidLivenessImpl: async () => ({ status: 'dead', reason: 'not_found' }),
    });
    assert.equal(state.processes.serverDrainingPid, null);
    assert.equal(state.processInstances.processes.serverDrainingPid, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a restart still captures a fresh identity for ordinary recorded processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-ordinary-start-'));
  try {
    const statePath = join(dir, 'stack.runtime.json');
    await recordStackRuntimeUpdate(statePath, {
      stackName: 'ordinary-test',
      ownerPid: process.pid,
      processes: { serverPid: process.pid },
    });
    const state = await recordStackRuntimeStart(statePath, { stackName: 'ordinary-test', ownerPid: process.pid });
    assert.equal(state.processInstances.processes.serverPid.pid, process.pid);
    assert.equal(typeof state.processInstances.processes.serverPid.fingerprint, 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a restart replaces a stale verified identity rather than carrying it forward', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-stale-verified-'));
  try {
    const statePath = join(dir, 'stack.runtime.json');
    await recordStackRuntimeUpdate(statePath, {
      stackName: 'ordinary-test',
      ownerPid: process.pid,
      processes: { serverPid: process.pid },
      verifiedProcessInstances: { serverPid: { pid: process.pid, fingerprint: 'stale-identity' } },
    });
    const state = await recordStackRuntimeStart(statePath, { stackName: 'ordinary-test', ownerPid: process.pid });
    assert.notEqual(state.processInstances.processes.serverPid.fingerprint, 'stale-identity');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a proven API instance stays with its process and leaves with it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-runtime-api-instance-'));
  try {
    const statePath = join(dir, 'stack.runtime.json');
    const serverPid = { pid: 2147480500, fingerprint: 'win32-cim:listener', apiInstanceId: 'instance-1' };
    await recordStackRuntimeUpdate(statePath, {
      processes: { serverPid: serverPid.pid },
      verifiedProcessInstances: { serverPid },
    });
    await recordStackRuntimeUpdate(statePath, { ports: { server: 53944 } });
    let state = await readStackRuntimeStateFile(statePath);
    assert.deepEqual(state.processInstances.processes.serverPid, serverPid);

    await recordStackRuntimeUpdate(statePath, {
      processes: { serverPid: 2147480501 },
      verifiedProcessInstances: { serverPid: { pid: 2147480501, fingerprint: 'win32-cim:replacement' } },
    });
    state = await readStackRuntimeStateFile(statePath);
    assert.deepEqual(state.processInstances.processes.serverPid, { pid: 2147480501, fingerprint: 'win32-cim:replacement' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
