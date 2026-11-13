import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPidAlive } from './pids.mjs';
import { killPidOwnedByStack, killProcessGroupOwnedByStack } from './ownership.mjs';
import { spawnDetachedTestProcess } from '../../testkit/core/spawn_test_process.mjs';

test('killProcessGroupOwnedByStack treats an already-exited pid as completed cleanup', async () => {
  let terminated = false;
  const result = await killProcessGroupOwnedByStack(4242, {
    stackName: 't',
    envPath: '/tmp/t/env',
    json: true,
    resolvePidStackOwnershipImpl: async () => ({
      status: 'not_owned',
      owned: false,
      reason: 'process-not-found',
    }),
    terminateProcessGroupImpl: async () => {
      terminated = true;
      return { ok: true };
    },
  });

  assert.deepEqual(result, { killed: true, reason: 'already_exited' });
  assert.equal(terminated, false);
});

test('killProcessGroupOwnedByStack routes Windows owned cleanup through the tree owner', async () => {
  const calls = [];
  const result = await killProcessGroupOwnedByStack(4242, {
    stackName: 't',
    envPath: 'C:\\stack\\env',
    processInstanceFingerprint: 'win32-cim:owned',
    json: true,
    platform: 'win32',
    resolvePidStackOwnershipImpl: async () => ({ owned: true, reason: 'env_file' }),
    getProcessGroupIdImpl: async () => { throw new Error('Windows must not require POSIX PGID'); },
    killPidImpl: async () => { throw new Error('leader-only kill is not tree cleanup'); },
    terminateProcessGroupImpl: async (pid, options) => {
      calls.push({ pid, options });
      return { ok: true, signal: 'SIGKILL' };
    },
  });

  assert.equal(result.killed, true);
  assert.equal(result.reason, 'killed_tree');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, 4242);
  assert.equal(calls[0]?.options?.identityPid, 4242);
  assert.equal(calls[0]?.options?.processInstanceFingerprint, 'win32-cim:owned');
});

test('killProcessGroupOwnedByStack does not report a PID-only no-op signal as killed', async () => {
  const result = await killProcessGroupOwnedByStack(4242, {
    stackName: 't',
    envPath: '/tmp/t/env',
    processInstanceFingerprint: 'linux-proc:owned',
    json: true,
    resolvePidStackOwnershipImpl: async () => ({ owned: true, reason: 'env_file' }),
    getProcessGroupIdImpl: async () => null,
    terminateProcessPidImpl: async () => ({ ok: false, reason: 'pid_still_alive' }),
  });

  assert.deepEqual(result, { killed: false, reason: 'pid_still_alive', signal: undefined });
});

test('killPidOwnedByStack retains cleanup state when death is unproven', async () => {
  const result = await killPidOwnedByStack(4242, {
    stackName: 't',
    envPath: '/tmp/t/env',
    processInstanceFingerprint: 'linux-proc:owned',
    json: true,
    resolvePidStackOwnershipImpl: async () => ({ owned: true, reason: 'env_file' }),
    terminateProcessPidImpl: async () => ({ ok: false, reason: 'liveness_inconclusive' }),
  });

  assert.deepEqual(result, { killed: false, reason: 'liveness_inconclusive', signal: undefined });
});

test('killPidOwnedByStack retains the proven process incarnation through termination', async () => {
  const calls = [];
  const result = await killPidOwnedByStack(4242, {
    stackName: 't',
    envPath: '/tmp/t/env',
    processInstanceFingerprint: 'linux-proc:owned',
    json: true,
    readProcessInstanceFingerprintImpl: () => assert.fail('supplied identity must not be replaced by a new snapshot'),
    resolvePidStackOwnershipImpl: async () => ({ owned: true, reason: 'process_instance' }),
    terminateProcessPidImpl: async (pid, options) => {
      calls.push({ pid, options });
      return { ok: false, reason: 'process_instance_mismatch', signal: 'SIGTERM' };
    },
  });

  assert.equal(calls[0]?.pid, 4242);
  assert.equal(calls[0]?.options?.processInstanceFingerprint, 'linux-proc:owned');
  assert.deepEqual(result, { killed: false, reason: 'process_instance_mismatch', signal: 'SIGTERM' });
});

test('killProcessGroupOwnedByStack retains the proven leader incarnation through group termination', async () => {
  const calls = [];
  const result = await killProcessGroupOwnedByStack(4242, {
    stackName: 't',
    envPath: '/tmp/t/env',
    processInstanceFingerprint: 'linux-proc:owned',
    json: true,
    readProcessInstanceFingerprintImpl: () => assert.fail('supplied identity must not be replaced by a new snapshot'),
    resolvePidStackOwnershipImpl: async () => ({ owned: true, reason: 'process_instance' }),
    getProcessGroupIdImpl: async (pid) => Number(pid) === 4242 ? 5151 : 6161,
    terminateProcessGroupImpl: async (pid, options) => {
      calls.push({ pid, options });
      return { ok: false, reason: 'process_instance_mismatch', signal: 'SIGTERM' };
    },
  });

  assert.equal(calls[0]?.pid, 5151);
  assert.equal(calls[0]?.options?.identityPid, 4242);
  assert.equal(calls[0]?.options?.processInstanceFingerprint, 'linux-proc:owned');
  assert.deepEqual(result, { killed: false, reason: 'process_instance_mismatch', pgid: 5151, signal: 'SIGTERM' });
});

const legacyStackStopEntryShapes = [
  {
    name: 'old runtime lifecycle owner',
    invoke: async (dependencies) => await killPidOwnedByStack(4242, {
      stackName: 't',
      envPath: '/tmp/t/env',
      json: true,
      ...dependencies,
    }),
    expectedTerminationTarget: 4242,
    expectedIdentityPid: null,
  },
  {
    name: 'old runtime process entry',
    invoke: async (dependencies) => await killProcessGroupOwnedByStack(4242, {
      stackName: 't',
      envPath: '/tmp/t/env',
      json: true,
      getProcessGroupIdImpl: async (pid) => Number(pid) === 4242 ? 5151 : 6161,
      ...dependencies,
    }),
    expectedTerminationTarget: 5151,
    expectedIdentityPid: 4242,
  },
  {
    name: 'Expo or mobile state PID entry',
    invoke: async (dependencies) => await killProcessGroupOwnedByStack(4242, {
      stackName: 't',
      envPath: '/tmp/t/env',
      json: true,
      getProcessGroupIdImpl: async () => null,
      ...dependencies,
    }),
    expectedTerminationTarget: 4242,
    expectedIdentityPid: null,
  },
  {
    name: 'env-tagged sweep self-PGID entry',
    invoke: async (dependencies) => await killProcessGroupOwnedByStack(4242, {
      stackName: 't',
      envPath: '/tmp/t/env',
      json: true,
      getProcessGroupIdImpl: async () => 5151,
      ...dependencies,
    }),
    expectedTerminationTarget: 4242,
    expectedIdentityPid: null,
  },
];

test('canonical stack termination owners pin legacy numeric PID entry shapes to one process incarnation', async (t) => {
  for (const entryShape of legacyStackStopEntryShapes) {
    await t.test(`${entryShape.name} fails closed when process incarnation is unavailable`, async () => {
      let ownershipCalls = 0;
      let terminationCalls = 0;
      const result = await entryShape.invoke({
        readProcessInstanceFingerprintImpl: () => null,
        observePidLivenessImpl: () => ({ status: 'alive' }),
        resolvePidStackOwnershipImpl: async () => {
          ownershipCalls += 1;
          return { owned: true, reason: 'env_file' };
        },
        terminateProcessPidImpl: async () => {
          terminationCalls += 1;
          return { ok: true };
        },
        terminateProcessGroupImpl: async () => {
          terminationCalls += 1;
          return { ok: true };
        },
      });

      assert.deepEqual(result, { killed: false, reason: 'process_instance_unavailable' });
      assert.equal(ownershipCalls, 0);
      assert.equal(terminationCalls, 0);
    });

    await t.test(`${entryShape.name} carries its entry snapshot through same-numeric replacement`, async () => {
      const fingerprint = `linux-proc:${entryShape.name}`;
      let ownershipContext = null;
      const terminationCalls = [];
      const terminateAsReplaced = async (targetPid, options) => {
        terminationCalls.push({ targetPid, options });
        return { ok: false, reason: 'process_instance_mismatch', signal: 'SIGTERM' };
      };
      const result = await entryShape.invoke({
        readProcessInstanceFingerprintImpl: () => fingerprint,
        resolvePidStackOwnershipImpl: async (_pid, context) => {
          ownershipContext = context;
          return { owned: true, reason: 'env_file' };
        },
        terminateProcessPidImpl: terminateAsReplaced,
        terminateProcessGroupImpl: terminateAsReplaced,
      });

      assert.equal(ownershipContext?.processInstanceFingerprint, fingerprint);
      assert.equal(terminationCalls.length, 1);
      assert.equal(terminationCalls[0]?.targetPid, entryShape.expectedTerminationTarget);
      assert.equal(terminationCalls[0]?.options?.processInstanceFingerprint, fingerprint);
      assert.equal(
        terminationCalls[0]?.options?.identityPid ?? null,
        entryShape.expectedIdentityPid,
      );
      assert.equal(result.killed, false);
      assert.equal(result.reason, 'process_instance_mismatch');
    });
  }

  await t.test('Windows legacy numeric PID state fails closed without persisted ownership identity', async () => {
    let ownershipCalls = 0;
    let terminationCalls = 0;
    const result = await killProcessGroupOwnedByStack(4242, {
      stackName: 't',
      envPath: 'C:\\stack\\env',
      json: true,
      platform: 'win32',
      readProcessInstanceFingerprintImpl: () => 'win32-cim:unproven-current-process',
      observePidLivenessImpl: () => ({ status: 'alive' }),
      resolvePidStackOwnershipImpl: async () => {
        ownershipCalls += 1;
        return { owned: true, reason: 'process_instance' };
      },
      terminateProcessGroupImpl: async () => {
        terminationCalls += 1;
        return { ok: true, signal: 'SIGKILL' };
      },
    });

    assert.deepEqual(result, { killed: false, reason: 'process_instance_unavailable' });
    assert.equal(ownershipCalls, 0);
    assert.equal(terminationCalls, 0);
  });
});

function spawnOwnedGracefulExit({ env, exitFile, readyFile }) {
  const cleanEnv = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v == null) continue;
    cleanEnv[k] = String(v);
  }

  // Wait for SIGINT/SIGTERM, then write a marker file right before exiting.
  const code = `
    const fs = require('fs');
    const exitFile = process.argv[1];
    const readyFile = process.argv[2];
    function onStop() {
      setTimeout(() => {
        try { fs.writeFileSync(exitFile, 'ok'); } catch {}
        process.exit(0);
      }, 120);
    }
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    try { fs.writeFileSync(readyFile, 'ready'); } catch {}
    setInterval(() => {}, 1000);
  `;

  return spawnDetachedTestProcess(process.execPath, ['-e', code, exitFile, readyFile], {
    env: cleanEnv,
    stdio: 'ignore',
  });
}

async function waitForCondition({ description, timeoutMs, intervalMs = 30, fn }) {
  const end = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for condition: ${description}`);
}

async function waitForFile(path, timeoutMs) {
  await waitForCondition({
    description: `file to exist at ${path}`,
    timeoutMs,
    fn: async () => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  });
}

async function waitForFileContent(path, timeoutMs) {
  let content = '';
  await waitForCondition({
    description: `file content at ${path}`,
    timeoutMs,
    fn: async () => {
      try {
        content = (await readFile(path, 'utf-8')).trim();
        return Boolean(content);
      } catch {
        return false;
      }
    },
  });
  return content;
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ignore
  }
}

test('killProcessGroupOwnedByStack allows graceful exit before SIGKILL', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group signaling semantics');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-kill-grace-'));
  const envPath = join(tmp, 'env');
  const exitFile = join(tmp, 'exited.txt');
  const readyFile = join(tmp, 'ready.txt');

  const child = spawnOwnedGracefulExit({
    readyFile,
    exitFile,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 't',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  });

  try {
    assert.ok(Number(child.pid) > 1, 'expected child pid');
    assert.ok(isPidAlive(child.pid), 'expected child alive before kill');

    await waitForFile(readyFile, 1200);

    const res = await killProcessGroupOwnedByStack(child.pid, {
      stackName: 't',
      envPath,
      cliHomeDir: '',
      json: true,
      graceMs: 600,
    });

    assert.equal(res.killed, true);
    assert.equal(isPidAlive(child.pid), false, 'expected child to exit');

    await waitForFile(exitFile, 1200);
  } finally {
    killGroup(child.pid);
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('killProcessGroupOwnedByStack honors requested initial signal when provided', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group signaling semantics');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-kill-signal-'));
  const envPath = join(tmp, 'env');
  const signalFile = join(tmp, 'signal.txt');
  const readyFile = join(tmp, 'ready.txt');

  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      `
      const fs = require('fs');
      const signalFile = process.argv[1];
      const readyFile = process.argv[2];
      let done = false;
      function onSignal(sig) {
        if (done) return;
        done = true;
        try { fs.writeFileSync(signalFile, sig); } catch {}
        setTimeout(() => process.exit(0), 30);
      }
      process.on('SIGINT', () => onSignal('SIGINT'));
      process.on('SIGTERM', () => onSignal('SIGTERM'));
      try { fs.writeFileSync(readyFile, 'ready'); } catch {}
      setInterval(() => {}, 1000);
    `,
      signalFile,
      readyFile,
    ],
    {
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 't',
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_PROCESS_KIND: 'infra',
      },
      stdio: 'ignore',
    }
  );

  try {
    assert.ok(Number(child.pid) > 1, 'expected child pid');
    assert.ok(isPidAlive(child.pid), 'expected child alive before kill');
    await waitForFile(readyFile, 1200);

    const res = await killProcessGroupOwnedByStack(child.pid, {
      stackName: 't',
      envPath,
      signal: 'SIGTERM',
      graceMs: 600,
      json: true,
    });
    assert.equal(res.killed, true);

    const firstSignal = await waitForFileContent(signalFile, 1200);
    assert.ok(firstSignal, 'expected signal marker file to be written');
    assert.equal(firstSignal, 'SIGTERM');
  } finally {
    killGroup(child.pid);
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('killProcessGroupOwnedByStack refuses stack session process kind', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group signaling semantics');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-kill-refuse-session-kind-'));
  const envPath = join(tmp, 'env');
  const exitFile = join(tmp, 'exited.txt');
  const readyFile = join(tmp, 'ready.txt');

  const child = spawnOwnedGracefulExit({
    readyFile,
    exitFile,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 't',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  });

  try {
    assert.ok(Number(child.pid) > 1, 'expected child pid');
    assert.ok(isPidAlive(child.pid), 'expected child alive before kill');

    await waitForFile(readyFile, 1200);

    const res = await killProcessGroupOwnedByStack(child.pid, {
      stackName: 't',
      envPath,
      cliHomeDir: '',
      json: true,
      graceMs: 300,
    });

    assert.equal(res.killed, false);
    assert.equal(res.reason, 'session_process_kind');
    assert.equal(isPidAlive(child.pid), true, 'expected session-kind child to survive stack ownership kill');
  } finally {
    killGroup(child.pid);
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('killPidOwnedByStack refuses stack session process kind', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process ownership inspection');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-kill-pid-refuse-session-kind-'));
  const envPath = join(tmp, 'env');
  const exitFile = join(tmp, 'exited.txt');
  const readyFile = join(tmp, 'ready.txt');

  const child = spawnOwnedGracefulExit({
    readyFile,
    exitFile,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 't',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  });

  try {
    assert.ok(Number(child.pid) > 1, 'expected child pid');
    assert.ok(isPidAlive(child.pid), 'expected child alive before kill');

    await waitForFile(readyFile, 1200);

    const res = await killPidOwnedByStack(child.pid, {
      stackName: 't',
      envPath,
      cliHomeDir: '',
      json: true,
    });

    assert.equal(res.killed, false);
    assert.equal(res.reason, 'session_process_kind');
    assert.equal(isPidAlive(child.pid), true, 'expected session-kind child to survive stack ownership kill');
  } finally {
    killGroup(child.pid);
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('killProcessGroupOwnedByStack does not signal the caller process group when target shares PGID', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group signaling semantics');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-kill-self-pgid-'));
  const envPath = join(tmp, 'env');
  const ownershipModuleUrl = new URL('./ownership.mjs', import.meta.url).href;

  const runner = spawn(
    process.execPath,
    [
      '-e',
      `
      const { spawn } = require('node:child_process');

      (async () => {
        const mod = await import(${JSON.stringify(ownershipModuleUrl)});
        const envPath = process.argv[1];
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          env: {
            ...process.env,
            HAPPIER_STACK_STACK: 't',
            HAPPIER_STACK_ENV_FILE: envPath,
            HAPPIER_STACK_PROCESS_KIND: 'infra',
          },
          stdio: 'ignore',
          detached: false,
        });

        try {
          const res = await mod.killProcessGroupOwnedByStack(child.pid, {
            stackName: 't',
            envPath,
            json: true,
            graceMs: 400,
          });
          process.stdout.write(JSON.stringify(res) + '\\n');
          process.exit(0);
        } catch (err) {
          process.stderr.write(String(err && err.message ? err.message : err));
          process.exit(1);
        }
      })();
    `,
      envPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  runner.stdout?.on('data', (d) => {
    stdout += d.toString();
  });
  runner.stderr?.on('data', (d) => {
    stderr += d.toString();
  });

  const status = await new Promise((resolvePromise) => {
    runner.on('exit', (code, signal) => resolvePromise({ code, signal }));
    runner.on('error', (err) => resolvePromise({ code: -1, signal: String(err) }));
  });

  try {
    assert.equal(status.code, 0, `runner failed (signal=${status.signal ?? 'null'}) stderr=${stderr}`);
    const line = stdout.trim().split('\n').filter(Boolean).at(-1) || '';
    const parsed = JSON.parse(line || '{}');
    assert.equal(parsed.killed, true);
    assert.equal(parsed.reason, 'killed_pid_only');
  } finally {
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const RECORDED_INSTANCE = 'win32-cim:2026-11-07T04:27:00.0000000Z';
const UNAVAILABLE_IDENTITY = { status: 'inconclusive', owned: null, reason: 'process_instance_unavailable' };

function killAfterProof(ownership, liveness, terminated) {
  const calls = [];
  return {
    calls,
    result: killProcessGroupOwnedByStack(4242, {
      stackName: 't',
      envPath: '/tmp/t/env',
      json: true,
      platform: 'win32',
      processInstanceFingerprint: RECORDED_INSTANCE,
      resolvePidStackOwnershipImpl: async () => ownership,
      observePidLivenessImpl: () => ({ status: liveness }),
      terminateProcessGroupImpl: async (pid, options) => {
        calls.push({ pid, identityPid: options.identityPid, fingerprint: options.processInstanceFingerprint });
        return terminated;
      },
    }),
  };
}

test('a recorded process that exits during its proof goes to the tree owner, not straight to success', async () => {
  const kill = killAfterProof(UNAVAILABLE_IDENTITY, 'dead', { ok: true, alreadyExited: true });

  assert.deepEqual(await kill.result, { killed: true, reason: 'already_exited' });
  assert.deepEqual(kill.calls, [{ pid: 4242, identityPid: 4242, fingerprint: RECORDED_INSTANCE }]);
});

test('a recorded process that exits during its proof stays failed while its tree is unproven', async () => {
  const kill = killAfterProof(UNAVAILABLE_IDENTITY, 'dead', { ok: false, reason: 'descendants_remain' });

  assert.deepEqual(await kill.result, { killed: false, reason: 'descendants_remain' });
});

const refusedProofs = [
  ['the process is still alive', UNAVAILABLE_IDENTITY, 'alive', 'process_instance_unavailable'],
  ['liveness is inconclusive', UNAVAILABLE_IDENTITY, 'inconclusive', 'process_instance_unavailable'],
  [
    'the PID was reused and has gone',
    { status: 'not_owned', owned: false, reason: 'process_instance_mismatch' },
    'dead',
    'process_instance_mismatch',
  ],
];

for (const [name, ownership, liveness, reason] of refusedProofs) {
  test(`a refused proof never reaches termination when ${name}`, async () => {
    const kill = killAfterProof(ownership, liveness, { ok: true });

    assert.deepEqual(await kill.result, { killed: false, reason });
    assert.deepEqual(kill.calls, []);
  });
}

test('killPidOwnedByStack accepts a recorded process that exits during its proof', async () => {
  const result = await killPidOwnedByStack(4242, {
    stackName: 't',
    envPath: '/tmp/t/env',
    json: true,
    platform: 'win32',
    processInstanceFingerprint: RECORDED_INSTANCE,
    resolvePidStackOwnershipImpl: async () => UNAVAILABLE_IDENTITY,
    observePidLivenessImpl: () => ({ status: 'dead' }),
    terminateProcessPidImpl: async () => assert.fail('a process that has gone must not be signalled'),
  });

  assert.deepEqual(result, { killed: true, reason: 'already_exited' });
});

test('a budgeted caller keeps its budget for the exited tree read', async () => {
  const signal = new AbortController().signal;
  const captures = [];
  await killProcessGroupOwnedByStack(4242, {
    stackName: 't',
    envPath: '/tmp/t/env',
    json: true,
    platform: 'win32',
    processInstanceFingerprint: RECORDED_INSTANCE,
    boundedIdentity: {
      timeoutMs: 321,
      signal,
      runCaptureImpl: async (_command, _args, options) => {
        captures.push(options);
        return '[]';
      },
    },
    resolvePidStackOwnershipImpl: async () => UNAVAILABLE_IDENTITY,
    observePidLivenessImpl: () => ({ status: 'dead' }),
    terminateProcessGroupImpl: async (pid, options) => {
      await options.boundary.observeProcessDescendants(pid, options.processInstanceFingerprint);
      return { ok: true };
    },
  });

  assert.deepEqual(captures, [{ timeoutMs: 321, signal }]);
});
