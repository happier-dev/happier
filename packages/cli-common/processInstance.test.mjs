import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isVerifiedProcessAncestry,
  observeProcessInstanceFingerprint,
  observeWindowsProcessAncestry,
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from './processInstance.mjs';

test('readProcessInstanceFingerprintSync reads the Linux proc start-time field', () => {
  const stat = `123 (node worker) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 987654 0 0`;
  assert.equal(
    readProcessInstanceFingerprintSync(123, {
      platform: 'linux',
      readFileSyncImpl: () => stat,
      spawnSyncImpl: () => {
        throw new Error('portable fallback must not run');
      },
    }),
    'linux-proc:987654',
  );
});

test('readProcessInstanceFingerprintSync reads a Windows CIM creation timestamp', () => {
  const calls = [];
  const fingerprint = readProcessInstanceFingerprintSync(456, {
    platform: 'win32',
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '2026-07-23T12:34:56.0000000Z\r\n' };
    },
  });

  assert.equal(fingerprint, 'win32-cim:2026-07-23T12:34:56.0000000Z');
  assert.equal(calls[0].command, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /ProcessId=456/);
  assert.equal(calls[0].options.shell, undefined);
});

test('processInstanceFingerprintMatches fails closed when either observation is unavailable', () => {
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', 'linux-proc:1'), true);
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', null), false);
  assert.equal(processInstanceFingerprintMatches(null, 'linux-proc:1'), false);
});

function createProbeRecorder(respond) {
  const calls = [];
  const runCaptureImpl = async (command, args, options) => {
    calls.push({ command, args, options });
    return await respond(command, args, options);
  };
  return { calls, runCaptureImpl };
}

test('observeProcessInstanceFingerprint rejects an exhausted budget before spawning', async () => {
  for (const timeoutMs of [0, -1, Number.NaN, undefined]) {
    const { calls, runCaptureImpl } = createProbeRecorder(async () => 'unused');
    assert.deepEqual(
      await observeProcessInstanceFingerprint(456, { platform: 'win32', timeoutMs, runCaptureImpl }),
      { status: 'inconclusive', reason: 'process-identity-timeout' },
    );
    assert.equal(calls.length, 0);
  }
});

test('observeProcessInstanceFingerprint honors a pre-aborted signal without spawning', async () => {
  const { calls, runCaptureImpl } = createProbeRecorder(async () => 'unused');
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await observeProcessInstanceFingerprint(456, {
      platform: 'win32',
      timeoutMs: 1_000,
      signal: controller.signal,
      runCaptureImpl,
    }),
    { status: 'inconclusive', reason: 'process-identity-cancelled' },
  );
  assert.equal(calls.length, 0);
});

test('observeProcessInstanceFingerprint passes the remaining budget to the subprocess and matches the sync format', async () => {
  const timestamp = '2026-07-23T12:34:56.0000000Z';
  const { calls, runCaptureImpl } = createProbeRecorder(async () => `${timestamp}\r\n`);
  const controller = new AbortController();
  const observed = await observeProcessInstanceFingerprint(456, {
    platform: 'win32',
    timeoutMs: 1_234,
    signal: controller.signal,
    runCaptureImpl,
  });
  const syncFingerprint = readProcessInstanceFingerprintSync(456, {
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 0, stdout: `${timestamp}\r\n` }),
  });
  assert.deepEqual(observed, { status: 'ok', fingerprint: syncFingerprint });
  assert.equal(calls[0].command, 'powershell.exe');
  assert.equal(calls[0].options.timeoutMs, 1_234);
  assert.equal(calls[0].options.signal, controller.signal);
});

test('observeProcessInstanceFingerprint classifies probe failures without any fallback', async () => {
  const failing = (properties) => createProbeRecorder(async () => {
    throw Object.assign(new Error('probe failed'), properties);
  }).runCaptureImpl;
  const observe = (runCaptureImpl, platform = 'win32') => observeProcessInstanceFingerprint(456, {
    platform,
    timeoutMs: 1_000,
    runCaptureImpl,
    readFileSyncImpl: () => {
      throw new Error('no proc entry');
    },
  });
  assert.deepEqual(await observe(failing({ code: 'ETIMEDOUT' })), { status: 'inconclusive', reason: 'process-identity-timeout' });
  assert.deepEqual(await observe(failing({ code: 'ABORT_ERR' })), { status: 'inconclusive', reason: 'process-identity-cancelled' });
  assert.deepEqual(await observe(failing({ code: 'EEXIT', exitCode: 1 })), { status: 'inconclusive', reason: 'process-identity-unavailable' });
  assert.deepEqual(await observe(failing({ code: 'EEXIT', exitCode: 3 })), { status: 'not_found' });
  assert.deepEqual(await observe(failing({ code: 'EEXIT', exitCode: 1 }), 'darwin'), { status: 'not_found' });
  assert.deepEqual(await observe(createProbeRecorder(async () => '  ').runCaptureImpl), { status: 'inconclusive', reason: 'process-identity-unavailable' });
});

test('observeProcessInstanceFingerprint reads Linux proc identity without a subprocess', async () => {
  const stat = `123 (node worker) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 987654 rest`;
  const { calls, runCaptureImpl } = createProbeRecorder(async () => 'unused');
  assert.deepEqual(
    await observeProcessInstanceFingerprint(123, {
      platform: 'linux',
      timeoutMs: 1_000,
      runCaptureImpl,
      readFileSyncImpl: () => stat,
    }),
    { status: 'ok', fingerprint: 'linux-proc:987654' },
  );
  assert.equal(calls.length, 0);
});

test('observeWindowsProcessAncestry returns creation-stamped rows and stays bounded', async () => {
  const rows = [
    { pid: 30, parentPid: 20, creationDate: '2026-07-23T12:00:03.0000000Z' },
    { pid: 20, parentPid: 10, creationDate: '2026-07-23T12:00:02.0000000Z' },
  ];
  const { calls, runCaptureImpl } = createProbeRecorder(async () => JSON.stringify(rows));
  assert.deepEqual(
    await observeWindowsProcessAncestry(30, { stopAtPid: 20, timeoutMs: 900, runCaptureImpl }),
    {
      status: 'ok',
      rows: [
        { pid: 30, parentPid: 20, fingerprint: 'win32-cim:2026-07-23T12:00:03.0000000Z' },
        { pid: 20, parentPid: 10, fingerprint: 'win32-cim:2026-07-23T12:00:02.0000000Z' },
      ],
    },
  );
  assert.equal(calls[0].options.timeoutMs, 900);

  const exhausted = createProbeRecorder(async () => 'unused');
  assert.deepEqual(
    await observeWindowsProcessAncestry(30, { stopAtPid: 20, timeoutMs: 0, runCaptureImpl: exhausted.runCaptureImpl }),
    { status: 'inconclusive', reason: 'process-identity-timeout' },
  );
  assert.equal(exhausted.calls.length, 0);
  assert.deepEqual(
    await observeWindowsProcessAncestry(30, {
      stopAtPid: 20,
      timeoutMs: 900,
      runCaptureImpl: createProbeRecorder(async () => 'not json').runCaptureImpl,
    }),
    { status: 'inconclusive', reason: 'process-identity-unavailable' },
  );
});

test('isVerifiedProcessAncestry requires an unbroken, time-ordered chain to the unchanged ancestor', () => {
  const row = (pid, parentPid, second) => ({
    pid,
    parentPid,
    fingerprint: `win32-cim:2026-07-23T12:00:0${second}.0000000Z`,
  });
  const ancestorFingerprint = row(20, 10, 1).fingerprint;
  const verify = (rows, overrides = {}) => isVerifiedProcessAncestry(rows, {
    leafPid: 40,
    ancestorPid: 20,
    ancestorFingerprint,
    ...overrides,
  });

  assert.equal(verify([row(40, 30, 3), row(30, 20, 2), row(20, 10, 1)]), true);
  assert.equal(verify([row(40, 30, 3), row(20, 10, 1)]), false, 'gap in the chain');
  assert.equal(verify([row(40, 30, 3), row(30, 99, 2)]), false, 'never reaches the ancestor');
  assert.equal(verify([row(40, 30, 1), row(30, 20, 3), row(20, 10, 2)]), false, 'parent newer than child');
  assert.equal(verify([row(40, 30, 3), row(30, 20, 2), row(20, 10, 2)]), false, 'ancestor identity changed');
  assert.equal(verify([]), false);
});
