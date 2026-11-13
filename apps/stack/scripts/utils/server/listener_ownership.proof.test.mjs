import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createListenerOwnershipObservationScope,
  proveSpawnedServerOwnership,
  trackSpawnedServerProcess,
} from './listener_ownership.mjs';
import { fetchExactServerReadyIdentity } from './server.mjs';

const NONCE = 'attempt-nonce-1';
const ENDPOINT = { host: '127.0.0.1', port: 53944 };
const INSTANCE_ID = 'instance-1';
const ROOT_CREATED = '2026-11-06T20:00:00.0000000Z';
const LEAF_CREATED = '2026-11-06T20:00:01.0000000Z';
const WRAPPER_PID = 4242;
const SERVER_PID = process.pid; // The receipt reader requires a live PID.

const apiReceipt = (overrides = {}) => ({
  nonce: NONCE,
  pid: SERVER_PID,
  api: { instanceId: INSTANCE_ID, address: '0.0.0.0', port: ENDPOINT.port },
  ...overrides,
});

const ancestryRows = (rows) => JSON.stringify(rows);
const verifiedAncestry = ancestryRows([
  { pid: SERVER_PID, parentPid: WRAPPER_PID, creationDate: LEAF_CREATED },
  { pid: WRAPPER_PID, parentPid: 1000, creationDate: ROOT_CREATED },
]);

/** The OS process boundary: PowerShell or ps answers come from these tables, one read at a time. */
function createProcessBoundary({ created = {}, ancestry = verifiedAncestry, hang = () => false } = {}) {
  const calls = [];
  const reads = new Map();
  const runCaptureImpl = (command, args, { timeoutMs, signal }) => {
    const script = String(args.at(-1));
    const isAncestry = script.includes('$stopPid');
    const pid = isAncestry ? null : Number(/ProcessId=(\d+)/.exec(script)?.[1] ?? args.at(-1));
    const read = reads.get(pid) ?? 0;
    reads.set(pid, read + 1);
    const call = { command, kind: isAncestry ? 'ancestry' : 'fingerprint', pid, read, timeoutMs, aborted: false };
    calls.push(call);
    if (hang(call, calls)) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          call.aborted = true;
          reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
        }, { once: true });
      });
    }
    if (isAncestry) return Promise.resolve(ancestry);
    const answers = created[pid] ?? [pid === WRAPPER_PID ? ROOT_CREATED : LEAF_CREATED];
    return Promise.resolve(answers[Math.min(read, answers.length - 1)]);
  };
  return { calls, runCaptureImpl };
}

async function runProof(t, {
  platform = 'win32',
  exactProcess = true,
  spawnedPid = exactProcess ? SERVER_PID : WRAPPER_PID,
  receipt = apiReceipt(),
  receiptText,
  ready = [{ status: 'identity', instanceId: INSTANCE_ID }],
  listeners = { status: 'ok', supported: true, pids: [] },
  created,
  ancestry,
  hang,
  child = { exitCode: null },
  budgetMs = 400,
  nowImpl,
  signal,
  processGroups = {},
  rootIdentity,
  fetchImpl,
  receiptPathIsDirectory = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-ownership-proof-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'startup.json');
  const text = receiptText ?? (receipt ? JSON.stringify(receipt) : null);
  if (receiptPathIsDirectory) await mkdir(path);
  else if (text !== null) await writeFile(path, text);

  const boundary = createProcessBoundary({
    created: created ?? { [SERVER_PID]: [exactProcess ? ROOT_CREATED : LEAF_CREATED] },
    ancestry,
    hang,
  });
  const readyCalls = [];
  const fetchReadyIdentityImpl = async (request) => {
    readyCalls.push(request);
    if (fetchImpl) return await fetchExactServerReadyIdentity(request, { fetchImpl });
    return ready[Math.min(readyCalls.length - 1, ready.length - 1)] ?? null;
  };
  const observationScope = createListenerOwnershipObservationScope({
    totalTimeoutMs: budgetMs,
    attemptTimeoutMs: budgetMs,
    retryDelayMs: 0,
    retryInconclusive: false,
    listListenPidsWithStatusImpl: async (_port, options) => (
      typeof listeners === 'function' ? listeners(options) : listeners
    ),
    ...(nowImpl ? { nowImpl } : {}),
  });
  child.pid = spawnedPid;
  const tracked = trackSpawnedServerProcess(child, {
    signal,
    observationScope,
    platform,
    runCaptureImpl: boundary.runCaptureImpl,
  });
  t.after(() => tracked.close());
  const result = proveSpawnedServerOwnership(
    {
      endpoint: ENDPOINT,
      spawned: rootIdentity ? { ...tracked, identity: rootIdentity } : tracked,
      attempt: { path, nonce: NONCE },
      exactProcess,
    },
    {
      platform,
      runCaptureImpl: boundary.runCaptureImpl,
      fetchReadyIdentityImpl,
      getProcessGroupIdImpl: async (pid) => processGroups[pid] ?? null,
    },
  );
  return { result, boundary, readyCalls };
}

async function assertUnproven(t, options, reason) {
  const { result, boundary } = await runProof(t, options);
  await assert.rejects(result, (error) => {
    assert.equal(error.code, 'ESERVEROWNERSHIPUNPROVEN');
    assert.equal(error.reason, reason);
    return true;
  });
  return boundary;
}

test('a runtime-backed Windows server is proven by its exact process and API identity', async (t) => {
  const { result, readyCalls } = await runProof(t);
  assert.deepEqual(await result, {
    listenerPid: SERVER_PID,
    wrapperPid: SERVER_PID,
    proof: 'api_identity',
    receiptSettled: true,
    verifiedProcessInstances: {
      serverPid: { pid: SERVER_PID, fingerprint: `win32-cim:${ROOT_CREATED}`, apiInstanceId: INSTANCE_ID },
      serverWrapperPid: { pid: SERVER_PID, fingerprint: `win32-cim:${ROOT_CREATED}`, apiInstanceId: INSTANCE_ID },
    },
  });
  // Readiness must be re-read after the receipt, on the exact endpoint.
  assert.equal(readyCalls.length, 2);
  assert.deepEqual([readyCalls[1].host, readyCalls[1].port], [ENDPOINT.host, ENDPOINT.port]);
});

test('a source-wrapped Windows server is proven through verified ancestry to the spawned wrapper', async (t) => {
  const { result } = await runProof(t, { exactProcess: false, created: {} });
  assert.deepEqual(await result, {
    listenerPid: SERVER_PID,
    wrapperPid: WRAPPER_PID,
    proof: 'api_identity',
    receiptSettled: true,
    verifiedProcessInstances: {
      serverPid: { pid: SERVER_PID, fingerprint: `win32-cim:${LEAF_CREATED}`, apiInstanceId: INSTANCE_ID },
      serverWrapperPid: { pid: WRAPPER_PID, fingerprint: `win32-cim:${ROOT_CREATED}` },
    },
  });
});

test('a POSIX wrapped server needs the same process group and an agreeing listener', async (t) => {
  const groups = { [SERVER_PID]: WRAPPER_PID, [WRAPPER_PID]: WRAPPER_PID };
  const groupListeners = (options) => ({
    status: 'ok',
    supported: true,
    pids: options.processGroupId === WRAPPER_PID ? [SERVER_PID] : [],
  });
  const { result } = await runProof(t, {
    platform: 'darwin',
    exactProcess: false,
    created: {},
    processGroups: groups,
    listeners: groupListeners,
  });
  assert.equal((await result).proof, 'api_identity');

  await assertUnproven(t, {
    platform: 'darwin',
    exactProcess: false,
    created: {},
    processGroups: { ...groups, [SERVER_PID]: 77 },
    listeners: groupListeners,
  }, 'process-ancestry-unverified');

  await assertUnproven(t, {
    platform: 'darwin',
    exactProcess: false,
    created: {},
    processGroups: groups,
    listeners: (options) => ({
      status: 'ok',
      supported: true,
      pids: options.processGroupId === WRAPPER_PID ? [WRAPPER_PID] : [],
    }),
  }, 'listener-contradiction');
});

test('an older runtime without identity needs conclusive OS proof that the receipt does not contradict', async (t) => {
  const posix = {
    platform: 'darwin',
    exactProcess: false,
    created: {},
    ready: [{ status: 'legacy' }],
    receipt: null,
    listeners: { status: 'ok', supported: true, pids: [WRAPPER_PID] },
  };
  const { result } = await runProof(t, posix);
  assert.equal((await result).proof, 'os_listener');

  await assertUnproven(t, {
    ...posix,
    receipt: { nonce: NONCE, pid: SERVER_PID },
  }, 'receipt-contradicts-listener');
});

test('a Windows host that hides the listener fails closed when the API identity is missing', async (t) => {
  const { result } = await runProof(t, { ready: [{ status: 'legacy' }], receipt: { nonce: NONCE, pid: SERVER_PID } });
  await assert.rejects(result, /could not be proven on port 53944/);
});

const rejectedProofs = [
  ['a worker receipt with a foreign responder', { receipt: { nonce: NONCE, pid: SERVER_PID } }, 'receipt-missing_api'],
  ['a responder on another address', { receipt: apiReceipt({ api: { instanceId: INSTANCE_ID, address: '10.0.0.5', port: ENDPOINT.port } }) }, 'endpoint-mismatch'],
  ['a port disagreement', { receipt: apiReceipt({ api: { instanceId: INSTANCE_ID, address: '0.0.0.0', port: 1 } }) }, 'endpoint-mismatch'],
  ['an instance mismatch after the receipt', { ready: [{ status: 'identity', instanceId: INSTANCE_ID }, { status: 'identity', instanceId: 'foreign' }] }, 'api-identity-mismatch'],
  ['readiness lost after the receipt', { ready: [{ status: 'identity', instanceId: INSTANCE_ID }, { status: 'invalid', reason: 'ready-unavailable' }] }, 'api-identity-mismatch'],
  ['a stale nonce', { receipt: apiReceipt({ nonce: 'previous-attempt' }), budgetMs: 150 }, 'receipt-timeout'],
  ['a malformed receipt', { receiptText: '{"nonce":', budgetMs: 150 }, 'receipt-timeout'],
  ['a receipt from another process', { exactProcess: true, spawnedPid: WRAPPER_PID, created: { [WRAPPER_PID]: [ROOT_CREATED], [SERVER_PID]: [LEAF_CREATED] } }, 'receipt-pid-mismatch'],
  ['a reused PID', { created: { [SERVER_PID]: [ROOT_CREATED, LEAF_CREATED] } }, 'process-instance-mismatch'],
  ['a process replaced before revalidation', { created: { [SERVER_PID]: [ROOT_CREATED, ROOT_CREATED, LEAF_CREATED] } }, 'process-instance-changed'],
  ['a contradictory OS listener', { listeners: { status: 'ok', supported: true, pids: [SERVER_PID, 9999] } }, 'listener-contradiction'],
  ['a listener discovery error', { listeners: { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' } }, 'listener-discovery-inconclusive'],
  ['a child that exited', { child: { exitCode: 1 } }, 'server-process-exited'],
  ['a child that exited before an OS proof', { platform: 'darwin', exactProcess: false, created: {}, ready: [null], receipt: null, child: { exitCode: 1 }, listeners: { status: 'ok', supported: true, pids: [WRAPPER_PID] } }, 'server-process-exited'],
];

for (const [name, options, reason] of rejectedProofs) {
  test(`ownership proof rejects ${name}`, async (t) => {
    await assertUnproven(t, options, reason);
  });
}

const brokenAncestries = [
  ['a gap in the chain', [
    { pid: SERVER_PID, parentPid: 555, creationDate: LEAF_CREATED },
    { pid: WRAPPER_PID, parentPid: 1000, creationDate: ROOT_CREATED },
  ]],
  ['a parent newer than its child', [
    { pid: SERVER_PID, parentPid: WRAPPER_PID, creationDate: ROOT_CREATED },
    { pid: WRAPPER_PID, parentPid: 1000, creationDate: LEAF_CREATED },
  ]],
  ['a changed spawned identity', [
    { pid: SERVER_PID, parentPid: WRAPPER_PID, creationDate: LEAF_CREATED },
    { pid: WRAPPER_PID, parentPid: 1000, creationDate: '2026-11-06T19:00:00.0000000Z' },
  ]],
];

for (const [name, rows] of brokenAncestries) {
  test(`ownership proof rejects ancestry with ${name}`, async (t) => {
    await assertUnproven(t, { exactProcess: false, created: {}, ancestry: ancestryRows(rows) }, 'process-ancestry-unverified');
  });
}

const hungProbes = [
  ['root capture', { exactProcess: true }, (call) => call.read === 0, 'process-identity-timeout'],
  ['listener identity', { exactProcess: true }, (call) => call.read === 1, 'process-identity-timeout'],
  ['ancestry', { exactProcess: false, created: {} }, (call) => call.kind === 'ancestry', 'process-identity-timeout'],
  ['revalidation', { exactProcess: true }, (call) => call.read === 2, 'process-identity-timeout'],
];

for (const [name, options, hang, reason] of hungProbes) {
  test(`a hung CIM probe at ${name} is cancelled within the owner budget`, async (t) => {
    const startedAt = Date.now();
    const boundary = await assertUnproven(t, { ...options, hang, budgetMs: 200 }, reason);
    assert.ok(Date.now() - startedAt < 2_000, 'the rejection must arrive within the injected budget');
    const hungCalls = boundary.calls.filter((call) => hang(call, boundary.calls));
    assert.ok(hungCalls.length > 0);
    assert.equal(hungCalls.every((call) => call.aborted), true, 'the stalled probe must see the abort');
  });
}

test('shutdown cancels a proof that is waiting for the receipt', async (t) => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const { result } = await runProof(t, { receipt: null, budgetMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(result, (error) => error.reason === 'cancelled');
  assert.ok(Date.now() - startedAt < 5_000);
});

test('a server exit cancels a proof that is waiting for the receipt', async (t) => {
  const child = Object.assign(new EventEmitter(), { exitCode: null });
  const { result } = await runProof(t, { receipt: null, budgetMs: 30_000, child });
  setTimeout(() => {
    child.exitCode = 1;
    child.emit('exit', 1, null);
  }, 20);
  await assert.rejects(result, (error) => error.reason === 'server-process-exited');
});

test('an exhausted owner budget starts no process probe', async (t) => {
  let now = 1_000;
  const boundary = await assertUnproven(t, {
    budgetMs: 100,
    nowImpl: () => {
      now += 1_000;
      return now;
    },
    rootIdentity: Promise.resolve({ status: 'ok', fingerprint: `win32-cim:${ROOT_CREATED}` }),
  }, 'process-identity-timeout');
  assert.equal(boundary.calls.length, 0);
});

test('process probe budgets derive from the scope and link the caller signal', async () => {
  const scope = createListenerOwnershipObservationScope({ totalTimeoutMs: 80 });
  const seen = [];
  let aborted = false;
  const outcome = await scope.withProcessProbeBudget(({ timeoutMs, signal }) => new Promise((resolve) => {
    seen.push(timeoutMs);
    signal.addEventListener('abort', () => {
      aborted = true;
      resolve('aborted');
    }, { once: true });
  }));
  assert.deepEqual(outcome, { status: 'inconclusive', reason: 'process-identity-timeout' });
  assert.equal(aborted, true);
  assert.ok(seen[0] > 0 && seen[0] <= 80);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await createListenerOwnershipObservationScope({ totalTimeoutMs: 80 })
    .withProcessProbeBudget(() => assert.fail('a cancelled caller must not start a probe'), { signal: controller.signal });
  assert.deepEqual(cancelled, { status: 'inconclusive', reason: 'process-identity-cancelled' });
});

const readyResponse = (body, { status = 200, url } = {}) => async (requestUrl) => ({
  url: url ?? requestUrl,
  status,
  json: async () => body,
});
const legacyReady = readyResponse({ status: 'ok', service: 'happier-server' });
const legacyOsEvidence = {
  platform: 'darwin',
  exactProcess: false,
  created: {},
  receipt: null,
  fetchImpl: legacyReady,
  listeners: { status: 'ok', supported: true, pids: [WRAPPER_PID] },
};

const failedReadiness = [
  ['a redirect', async () => {
    throw new TypeError('fetch failed: unexpected redirect');
  }],
  ['a transport failure', async () => {
    throw new TypeError('fetch failed: ECONNRESET');
  }],
  ['a non-200 response', readyResponse({ status: 'ok', service: 'happier-server' }, { status: 503 })],
  ['a response from another URL', readyResponse({ status: 'ok', service: 'happier-server' }, { url: 'http://127.0.0.1:1/ready' })],
  ['an unhealthy payload', readyResponse({ status: 'degraded', service: 'happier-server' })],
  ['another service', readyResponse({ status: 'ok', service: 'other-service' })],
  ['a blank service', readyResponse({ status: 'ok', service: null })],
  ['a missing service', readyResponse({ status: 'ok' })],
  ['a malformed body', async (url) => ({
    url,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  })],
  ['a malformed identity', readyResponse({ status: 'ok', service: 'happier-server', apiStartupIdentity: { instanceId: '' } })],
];

for (const [name, fetchImpl] of failedReadiness) {
  test(`${name} from /ready never degrades to the legacy OS proof`, async (t) => {
    const { result } = await runProof(t, { ...legacyOsEvidence, fetchImpl });
    await assert.rejects(result, (error) => {
      assert.equal(error.code, 'ESERVEROWNERSHIPUNPROVEN');
      assert.match(error.reason, /^ready-/);
      return true;
    });
  });
}

test('legacy proof needs the root identity captured at spawn', async (t) => {
  await assertUnproven(t, {
    ...legacyOsEvidence,
    rootIdentity: Promise.resolve({ status: 'inconclusive', reason: 'process-identity-unavailable' }),
  }, 'process-identity-unavailable');
});

test('legacy proof fails when the server exits during listener observation', async (t) => {
  const child = { exitCode: null };
  await assertUnproven(t, {
    ...legacyOsEvidence,
    child,
    listeners: () => {
      child.exitCode = 1;
      return { status: 'ok', supported: true, pids: [WRAPPER_PID] };
    },
  }, 'server-process-exited');
});

test('legacy proof revalidates the process identity at the end', async (t) => {
  await assertUnproven(t, {
    ...legacyOsEvidence,
    created: { [WRAPPER_PID]: [ROOT_CREATED, ROOT_CREATED, LEAF_CREATED] },
  }, 'process-instance-changed');
});

test('a receipt with API evidence requires API proof even when /ready looks legacy', async (t) => {
  await assertUnproven(t, {
    ...legacyOsEvidence,
    spawnedPid: SERVER_PID,
    receipt: apiReceipt(),
    listeners: { status: 'ok', supported: true, pids: [SERVER_PID] },
    processGroups: { [SERVER_PID]: SERVER_PID },
  }, 'api-identity-mismatch');
});

test('a malformed receipt never degrades to the legacy OS proof', async (t) => {
  await assertUnproven(t, { ...legacyOsEvidence, receipt: null, receiptText: '{"nonce":' }, 'receipt-malformed');
});

test('a receipt for another attempt contradicts the legacy OS proof', async (t) => {
  await assertUnproven(t, {
    ...legacyOsEvidence,
    receipt: { nonce: 'previous-attempt', pid: WRAPPER_PID },
  }, 'receipt-contradicts-listener');
});

test('an exact legacy server must be the listener itself', async (t) => {
  await assertUnproven(t, {
    ...legacyOsEvidence,
    exactProcess: true,
    spawnedPid: WRAPPER_PID,
    listeners: { status: 'ok', supported: true, pids: [SERVER_PID] },
    processGroups: { [SERVER_PID]: WRAPPER_PID, [WRAPPER_PID]: WRAPPER_PID },
  }, 'listener-pid-mismatch');
});

test('a successful legacy proof carries verified identities and reports whether a receipt arrived', async (t) => {
  const withoutReceipt = await (await runProof(t, legacyOsEvidence)).result;
  assert.equal(withoutReceipt.proof, 'os_listener');
  assert.equal(withoutReceipt.receiptSettled, false);
  assert.deepEqual(withoutReceipt.verifiedProcessInstances.serverPid.pid, WRAPPER_PID);
  assert.deepEqual(withoutReceipt.verifiedProcessInstances.serverWrapperPid.pid, WRAPPER_PID);

  const withReceipt = await (await runProof(t, {
    ...legacyOsEvidence,
    receipt: { nonce: NONCE, pid: WRAPPER_PID },
  })).result;
  assert.equal(withReceipt.receiptSettled, true);
});

test('legacy readiness that changes after the listener proof fails the proof', async (t) => {
  let reads = 0;
  await assertUnproven(t, {
    ...legacyOsEvidence,
    fetchImpl: async (url) => {
      reads += 1;
      return reads === 1
        ? await legacyReady(url)
        : { url, status: 503, json: async () => ({}) };
    },
  }, 'ready-status');
});

test('a server exit cancels the root identity capture', async (t) => {
  const child = Object.assign(new EventEmitter(), { pid: WRAPPER_PID, exitCode: null });
  const boundary = createProcessBoundary({ hang: () => true });
  const tracked = trackSpawnedServerProcess(child, {
    platform: 'win32',
    runCaptureImpl: boundary.runCaptureImpl,
    observationScope: createListenerOwnershipObservationScope({ totalTimeoutMs: 30_000 }),
  });
  t.after(() => tracked.close());
  await new Promise((resolve) => setImmediate(resolve));
  child.exitCode = 1;
  child.emit('exit', 1, null);
  assert.deepEqual(await tracked.identity, { status: 'inconclusive', reason: 'process-identity-cancelled' });
  assert.equal(boundary.calls[0].aborted, true);
});

test('the capture and the proof share one budget', async (t) => {
  const startedAt = Date.now();
  const boundary = await assertUnproven(t, {
    budgetMs: 300,
    hang: (call) => call.read === 0 || call.read === 1,
  }, 'process-identity-timeout');
  assert.ok(Date.now() - startedAt < 1_500, 'a second full budget must not follow the first');
  assert.equal(boundary.calls.length, 1, 'a proof whose capture used the budget starts no further probe');
});

test('a slow healthy readiness wait does not consume the ownership budget', async () => {
  let now = 0;
  const scope = createListenerOwnershipObservationScope({ totalTimeoutMs: 1_000, nowImpl: () => now });
  now = 100;
  await scope.excludeFromBudget(async () => {
    now = 500_000;
  });
  assert.equal(scope.remainingMs(), 900);
  now += 900;
  assert.equal(scope.remainingMs(), 0);
});

test('legacy proof rejects a listener that is not the process captured at spawn', async (t) => {
  await assertUnproven(t, {
    ...legacyOsEvidence,
    created: { [WRAPPER_PID]: [ROOT_CREATED, LEAF_CREATED] },
  }, 'process-instance-changed');
});

test('an unreadable receipt is not an absent receipt', async (t) => {
  await assertUnproven(t, { ...legacyOsEvidence, receiptPathIsDirectory: true }, 'receipt-unreadable');
});

test('an unreadable receipt also fails the API proof', async (t) => {
  await assertUnproven(t, { receiptPathIsDirectory: true, receipt: null, budgetMs: 150 }, 'receipt-timeout');
});

const FOREIGN_PID = 9999;
const narrowOwnerBroadForeign = (reads) => (options) => {
  if (options.processGroupId) return { status: 'ok', supported: true, pids: [WRAPPER_PID] };
  reads.broad += 1;
  return { status: 'ok', supported: true, pids: [WRAPPER_PID, FOREIGN_PID] };
};

test('legacy proof rejects a foreign listener that the narrow group query cannot see', async (t) => {
  const reads = { broad: 0 };
  const { result } = await runProof(t, {
    ...legacyOsEvidence,
    listeners: narrowOwnerBroadForeign(reads),
    processGroups: { [WRAPPER_PID]: WRAPPER_PID, [FOREIGN_PID]: 7777 },
  });
  await assert.rejects(result, /answered by another process/);
  assert.equal(reads.broad, 1);
});

test('API proof rejects a foreign listener that the narrow group query cannot see', async (t) => {
  const reads = { broad: 0 };
  await assertUnproven(t, {
    platform: 'darwin',
    exactProcess: false,
    spawnedPid: SERVER_PID,
    created: {},
    processGroups: { [SERVER_PID]: SERVER_PID, [FOREIGN_PID]: 7777 },
    listeners: (options) => {
      if (options.processGroupId) return { status: 'ok', supported: true, pids: [SERVER_PID] };
      reads.broad += 1;
      return { status: 'ok', supported: true, pids: [SERVER_PID, FOREIGN_PID] };
    },
  }, 'listener-discovery-inconclusive');
  assert.equal(reads.broad, 1);
});

const inconclusiveBroadEvidence = [
  ['timeout', { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' }],
  ['error', { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' }],
  ['unsupported', { status: 'unsupported', supported: false, pids: [], reason: 'missing-listener-discovery-command' }],
];

for (const [name, broad] of inconclusiveBroadEvidence) {
  const narrowOwnerBroad = (pid) => (options) => (options.processGroupId
    ? { status: 'ok', supported: true, pids: [pid] }
    : broad);

  test(`legacy proof needs conclusive broad evidence: ${name}`, async (t) => {
    const { result } = await runProof(t, { ...legacyOsEvidence, listeners: narrowOwnerBroad(WRAPPER_PID) });
    await assert.rejects(result, (error) => {
      assert.equal(error.code, 'ELISTENERDISCOVERYINCONCLUSIVE');
      assert.equal(error.observation.reason, broad.reason);
      return true;
    });
  });

  test(`API proof needs conclusive broad evidence: ${name}`, async (t) => {
    await assertUnproven(t, {
      platform: 'darwin',
      exactProcess: false,
      spawnedPid: SERVER_PID,
      created: {},
      processGroups: { [SERVER_PID]: SERVER_PID },
      listeners: narrowOwnerBroad(SERVER_PID),
    }, 'listener-discovery-inconclusive');
  });
}

test('a stalled broad query fails closed inside the one proof budget', async (t) => {
  const startedAt = Date.now();
  const { result } = await runProof(t, {
    ...legacyOsEvidence,
    budgetMs: 600,
    listeners: (options) => (options.processGroupId
      ? { status: 'ok', supported: true, pids: [WRAPPER_PID] }
      : new Promise(() => {})),
  });
  await assert.rejects(result, (error) => error.code === 'ELISTENERDISCOVERYINCONCLUSIVE');
  assert.ok(Date.now() - startedAt < 600, 'the check must use a share of the budget, not all of it');
});

test('slow but conclusive broad evidence leaves the proof room to revalidate', async (t) => {
  const { result } = await runProof(t, {
    ...legacyOsEvidence,
    budgetMs: 900,
    listeners: async (options) => {
      if (options.processGroupId) return { status: 'ok', supported: true, pids: [WRAPPER_PID] };
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { status: 'ok', supported: true, pids: [WRAPPER_PID] };
    },
  });
  assert.equal((await result).proof, 'os_listener');
});
