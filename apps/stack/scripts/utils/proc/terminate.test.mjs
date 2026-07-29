import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { isPidAlive } from './pids.mjs';
import { terminateProcessGroup, terminateProcessPid } from './terminate.mjs';
import { spawnDetachedTestProcess } from '../../testkit/core/spawn_test_process.mjs';

async function waitForPidExit(pid, timeoutMs) {
  const end = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < end) {
    if (!isPidAlive(pid)) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for pid ${pid} to exit`);
}

test('terminateProcessGroup escalates to SIGKILL when child ignores SIGINT/SIGTERM', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group signaling semantics');
    return;
  }

  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      [
        "process.on('SIGINT', () => {});",
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join(' '),
    ],
    { stdio: 'ignore' }
  );
  try {
    assert.ok(child.pid && child.pid > 1, 'expected child pid');
    assert.ok(isPidAlive(child.pid), 'expected child to be alive');

    const res = await terminateProcessGroup(child.pid, { graceMs: 120 });
    assert.equal(res.ok, true, `expected terminate ok, got ${JSON.stringify(res)}`);

    await waitForPidExit(child.pid, 1200);
  } finally {
    if (child.pid && isPidAlive(child.pid)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
    }
  }
});

test('terminateProcessGroup uses bounded Windows tree termination before accepting leader exit', async () => {
  let leaderAlive = true;
  let directLeaderSignalCount = 0;
  const spawned = [];
  const boundary = {
    platform: 'win32',
    isPidAlive: () => leaderAlive,
    kill: () => { directLeaderSignalCount += 1; leaderAlive = false; },
    readProcessInstanceFingerprint: () => leaderAlive ? 'win32-cim:original' : null,
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => { leaderAlive = false; child.emit('exit', 0); });
      return child;
    },
  };
  const result = await terminateProcessGroup(4242, {
    graceMs: 120,
    signal: 'SIGTERM',
    processInstanceFingerprint: 'win32-cim:original',
    boundary,
  });
  assert.equal(result.ok, true);
  assert.equal(directLeaderSignalCount, 0);
  assert.deepEqual(spawned.map(({ command, args }) => ({ command, args })), [
    { command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] },
  ]);
});

test('terminateProcessGroup bounds a hung Windows taskkill process', async () => {
  let taskkillChildKillCount = 0;
  const boundary = {
    platform: 'win32',
    isPidAlive: () => true,
    kill: () => { throw new Error('must not directly signal the Windows leader'); },
    readProcessInstanceFingerprint: () => 'win32-cim:original',
    spawn: () => {
      const child = new EventEmitter();
      child.kill = () => { taskkillChildKillCount += 1; return true; };
      return child;
    },
  };
  const result = await terminateProcessGroup(4242, {
    graceMs: 50,
    signal: 'SIGTERM',
    processInstanceFingerprint: 'win32-cim:original',
    boundary,
  });
  assert.equal(result.ok, false);
  assert.equal(taskkillChildKillCount, 1);
});

test('terminateProcessGroup does not claim Windows tree cleanup from leader absence alone', async () => {
  let spawnCalls = 0;
  const result = await terminateProcessGroup(4242, {
    boundary: {
      platform: 'win32',
      isPidAlive: () => false,
      kill: () => {},
      spawn: () => { spawnCalls += 1; throw new Error('must not spawn without a live root'); },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'leader_absent_without_tree_proof');
  assert.equal(spawnCalls, 0);
});

test('terminateProcessGroup requires leader exit after successful Windows taskkill', async () => {
  const result = await terminateProcessGroup(4242, {
    graceMs: 50,
    boundary: {
      platform: 'win32',
      isPidAlive: () => true,
      kill: () => {},
      readProcessInstanceFingerprint: () => 'win32-cim:original',
      spawn: () => {
        const child = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      },
    },
    processInstanceFingerprint: 'win32-cim:original',
  });

  assert.equal(result.ok, false);
});

test('terminateProcessPid refuses to signal when the persisted process incarnation was already replaced', async () => {
  let signalCalls = 0;
  const result = await terminateProcessPid(4242, {
    processInstanceFingerprint: 'expected',
    boundary: {
      platform: 'linux',
      isPidAlive: () => true,
      kill: () => { signalCalls += 1; },
      readProcessInstanceFingerprint: () => 'replacement',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'process_instance_changed');
  assert.equal(signalCalls, 0);
});

test('terminateProcessPid observes a persisted predecessor Windows fingerprint in its original format', async () => {
  const predecessorFingerprint = 'win32-cim:2026-07-23T12:34:56.1234567Z';
  let alive = true;
  let signalCalls = 0;
  const result = await terminateProcessPid(4242, {
    processInstanceFingerprint: predecessorFingerprint,
    boundary: {
      platform: 'win32',
      isPidAlive: () => alive,
      kill: () => {
        signalCalls += 1;
        alive = false;
      },
      readProcessInstanceFingerprint: (_pid, expectedFingerprint) => (
        expectedFingerprint === predecessorFingerprint && alive
          ? predecessorFingerprint
          : null
      ),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(signalCalls, 1);
});

test('terminateProcessPid does not escalate when the exact incarnation changes after the wait deadline', async () => {
  let fingerprintReads = 0;
  const signals = [];
  const result = await terminateProcessPid(4242, {
    processInstanceFingerprint: 'expected',
    graceMs: 50,
    boundary: {
      platform: 'linux',
      isPidAlive: () => true,
      kill: (_pid, signal) => { signals.push(signal); },
      readProcessInstanceFingerprint: () => {
        fingerprintReads += 1;
        if (fingerprintReads === 2) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
        }
        return fingerprintReads <= 2 ? 'expected' : 'replacement';
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'process_instance_exited');
  assert.deepEqual(signals, ['SIGINT']);
});

test('terminateProcessGroup does not escalate when the identity incarnation changes after the wait deadline', async () => {
  let fingerprintReads = 0;
  const signals = [];
  const result = await terminateProcessGroup(4242, {
    processInstanceFingerprint: 'expected',
    graceMs: 50,
    boundary: {
      platform: 'linux',
      isPidAlive: () => true,
      kill: (_pid, signal) => {
        if (signal !== 0) signals.push(signal);
      },
      readProcessInstanceFingerprint: () => {
        fingerprintReads += 1;
        if (fingerprintReads === 2) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
        }
        return fingerprintReads <= 2 ? 'expected' : 'replacement';
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'process_instance_changed_before_group_cleanup');
  assert.deepEqual(signals, ['SIGINT']);
});

test('terminateProcessGroup rechecks identity before completing cleanup after the group exits', async () => {
  let groupAlive = true;
  let processInstanceFingerprint = 'expected';
  const signals = [];
  const result = await terminateProcessGroup(4242, {
    processInstanceFingerprint: 'expected',
    graceMs: 50,
    boundary: {
      platform: 'linux',
      isPidAlive: () => true,
      kill: (_pid, signal) => {
        if (signal === 0) {
          if (groupAlive) return;
          const error = new Error('group exited');
          error.code = 'ESRCH';
          throw error;
        }
        signals.push(signal);
        groupAlive = false;
        processInstanceFingerprint = 'replacement';
      },
      readProcessInstanceFingerprint: () => processInstanceFingerprint,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'process_instance_changed_before_group_cleanup');
  assert.deepEqual(signals, ['SIGINT']);
});
