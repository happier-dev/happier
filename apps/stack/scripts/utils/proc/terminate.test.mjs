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

test('terminateProcessPid does not claim cleanup when signaling succeeds but the pid remains alive', async () => {
  const signals = [];
  const result = await terminateProcessPid(4242, {
    graceMs: 50,
    boundary: {
      observePidLiveness: () => ({ status: 'alive', reason: 'test' }),
      kill: (_pid, signal) => signals.push(signal),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pid_still_alive');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('terminateProcessPid treats only observed death or ESRCH as completed cleanup', async () => {
  let probes = 0;
  const observed = await terminateProcessPid(4242, {
    graceMs: 50,
    boundary: {
      observePidLiveness: () => (++probes === 1
        ? { status: 'alive', reason: 'test' }
        : { status: 'dead', reason: 'not_found' }),
      kill: () => {},
    },
  });
  assert.equal(observed.ok, true);

  const esrch = new Error('gone');
  esrch.code = 'ESRCH';
  const raced = await terminateProcessPid(4242, {
    boundary: {
      observePidLiveness: () => ({ status: 'alive', reason: 'test' }),
      kill: () => { throw esrch; },
    },
  });
  assert.deepEqual(raced, { ok: true, alreadyExited: true, reason: 'already_exited' });
});

test('terminateProcessPid refuses to escalate after the owned process incarnation exits and its pid is reused', async () => {
  const signals = [];
  let observedFingerprint = 'linux-proc:owned';
  const result = await terminateProcessPid(4242, {
    graceMs: 50,
    processInstanceFingerprint: 'linux-proc:owned',
    boundary: {
      observePidLiveness: () => ({ status: 'alive', reason: 'test' }),
      readProcessInstanceFingerprint: () => observedFingerprint,
      kill: (_pid, signal) => {
        signals.push(signal);
        observedFingerprint = 'linux-proc:successor';
      },
    },
  });

  assert.deepEqual(result, { ok: false, reason: 'process_instance_mismatch', signal: 'SIGTERM' });
  assert.deepEqual(signals, ['SIGTERM']);
});

test('terminateProcessPid accepts observed incarnation death before the first signal without touching a reused numeric pid', async () => {
  let livenessProbes = 0;
  const signals = [];
  const result = await terminateProcessPid(4242, {
    processInstanceFingerprint: 'linux-proc:owned',
    boundary: {
      observePidLiveness: () => (
        ++livenessProbes === 1
          ? { status: 'alive', reason: 'test' }
          : { status: 'dead', reason: 'not_found' }
      ),
      readProcessInstanceFingerprint: () => {
        throw new Error('dead process must not require an incarnation probe');
      },
      kill: (_pid, signal) => signals.push(signal),
    },
  });

  assert.deepEqual(result, { ok: true, alreadyExited: true, reason: 'already_exited' });
  assert.deepEqual(signals, []);
});

test('terminateProcessGroup refuses to signal a group after its owned leader pid is reused', async () => {
  const signals = [];
  let observedFingerprint = 'linux-proc:owned';
  const result = await terminateProcessGroup(4242, {
    graceMs: 50,
    signal: 'SIGTERM',
    identityPid: 4242,
    processInstanceFingerprint: 'linux-proc:owned',
    boundary: {
      platform: 'linux',
      isPidAlive: () => true,
      observePidLiveness: () => ({ status: 'alive', reason: 'test' }),
      readProcessInstanceFingerprint: () => observedFingerprint,
      kill: (pid, signal) => {
        if (signal === 0) return;
        signals.push({ pid, signal });
        observedFingerprint = 'linux-proc:successor';
      },
    },
  });

  assert.deepEqual(result, { ok: false, reason: 'process_instance_mismatch', signal: 'SIGTERM' });
  assert.deepEqual(signals, [{ pid: -4242, signal: 'SIGTERM' }]);
});

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
    kill: () => {
      directLeaderSignalCount += 1;
      leaderAlive = false;
    },
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => {
        leaderAlive = false;
        child.emit('exit', 0);
      });
      return child;
    },
  };

  const result = await terminateProcessGroup(4242, {
    graceMs: 120,
    signal: 'SIGTERM',
    boundary,
  });

  assert.equal(result.ok, true);
  assert.equal(directLeaderSignalCount, 0, 'must not accept a directly terminated leader as tree completion');
  assert.deepEqual(spawned.map(({ command, args }) => ({ command, args })), [
    { command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] },
  ]);
});

test('terminateProcessGroup bounds a hung Windows taskkill process', async () => {
  let taskkillChildKillCount = 0;
  const boundary = {
    platform: 'win32',
    isPidAlive: () => true,
    kill: () => {
      throw new Error('must not directly signal the Windows leader');
    },
    spawn: () => {
      const child = new EventEmitter();
      child.kill = () => {
        taskkillChildKillCount += 1;
        return true;
      };
      return child;
    },
  };

  const result = await terminateProcessGroup(4242, {
    graceMs: 50,
    signal: 'SIGTERM',
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
      spawn: () => {
        const child = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      },
    },
  });

  assert.equal(result.ok, false);
});

const RECORDED_LEADER = 'win32-cim:2026-11-07T04:27:00.0000000Z';

function exitedWindowsLeader(descendants) {
  return {
    platform: 'win32',
    isPidAlive: () => false,
    kill: () => {},
    spawn: () => assert.fail('must not spawn without a live root'),
    observeProcessDescendants: async (pid, fingerprint) => {
      assert.equal(pid, 4242);
      assert.equal(fingerprint, RECORDED_LEADER);
      return descendants;
    },
  };
}

test('an exited recorded Windows leader with no descendants has proven its tree', async () => {
  const result = await terminateProcessGroup(4242, {
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: exitedWindowsLeader({ status: 'none' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyExited, true);
});

test('an exited Windows leader does not prove its tree while a child survives', async () => {
  const result = await terminateProcessGroup(4242, {
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: exitedWindowsLeader({ status: 'present', pids: [4343] }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'descendants_remain');
});

test('an exited Windows leader keeps the missing tree proof when descendants cannot be read', async () => {
  const result = await terminateProcessGroup(4242, {
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: exitedWindowsLeader({ status: 'inconclusive' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'leader_absent_without_tree_proof');
});

function leaderExitingDuringFailedTaskkill(descendants) {
  let leaderAlive = true;
  return {
    platform: 'win32',
    isPidAlive: () => leaderAlive,
    observePidLiveness: () => ({ status: leaderAlive ? 'alive' : 'dead' }),
    readProcessInstanceFingerprint: () => (leaderAlive ? RECORDED_LEADER : null),
    observeProcessDescendants: async () => descendants,
    spawn: () => {
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => {
        leaderAlive = false;
        child.emit('exit', 128);
      });
      return child;
    },
  };
}

test('a Windows leader that exits while taskkill fails is accepted only with tree proof', async () => {
  const proven = await terminateProcessGroup(4242, {
    graceMs: 60,
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: leaderExitingDuringFailedTaskkill({ status: 'none' }),
  });
  const survivor = await terminateProcessGroup(4242, {
    graceMs: 60,
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: leaderExitingDuringFailedTaskkill({ status: 'present', pids: [4343] }),
  });

  assert.equal(proven.ok, true);
  assert.equal(survivor.ok, false);
  assert.equal(survivor.reason, 'descendants_remain');
});

test('a failed taskkill is still a failure when the Windows leader stays alive', async () => {
  const boundary = leaderExitingDuringFailedTaskkill({ status: 'none' });
  const result = await terminateProcessGroup(4242, {
    graceMs: 60,
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: {
      ...boundary,
      isPidAlive: () => true,
      observePidLiveness: () => ({ status: 'alive' }),
      readProcessInstanceFingerprint: () => RECORDED_LEADER,
    },
  });

  assert.equal(result.ok, false);
});

test('terminateProcessPid accepts an exit that made its identity read come back empty', async () => {
  const liveness = ['alive', 'alive', 'dead'];
  let killed = false;
  const result = await terminateProcessPid(4242, {
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: {
      observePidLiveness: () => ({ status: liveness.shift() ?? 'dead' }),
      readProcessInstanceFingerprint: () => null,
      kill: () => { killed = true; },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyExited, true);
  assert.equal(killed, false);
});

test('an empty identity read of a live process stays unavailable', async () => {
  const result = await terminateProcessPid(4242, {
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: {
      observePidLiveness: () => ({ status: 'alive' }),
      readProcessInstanceFingerprint: () => null,
      kill: () => assert.fail('an unproven process must not be signalled'),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'process_instance_unavailable');
});

test('a fingerprint taken from another process cannot prove this leader exited tree', async () => {
  const result = await terminateProcessGroup(4242, {
    identityPid: 5252,
    processInstanceFingerprint: RECORDED_LEADER,
    boundary: {
      ...exitedWindowsLeader({ status: 'none' }),
      observeProcessDescendants: async () => assert.fail('the fingerprint does not date this leader'),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'leader_absent_without_tree_proof');
});
