import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPidAlive } from './pids.mjs';
import { killPidOwnedByStack, killProcessGroupOwnedByStack, observePsEnvLine } from './ownership.mjs';
import { spawnDetachedTestProcess } from '../../testkit/core/spawn_test_process.mjs';

test('process identity observation classifies failed ps for an exited pid as not found', async () => {
  const unavailable = new Error('ps returned no matching process');
  unavailable.code = 'ENOENT';
  const observation = await observePsEnvLine(4242, {
    platform: 'darwin',
    runCaptureImpl: async () => { throw unavailable; },
    readLinuxProcEnvironImpl: async () => '',
    observePidLivenessImpl: () => ({ status: 'dead', reason: 'not_found' }),
  });

  assert.deepEqual(
    { status: observation.status, line: observation.line, reason: observation.reason },
    { status: 'not_found', line: null, reason: 'process-not-found' },
  );
});

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
  const predecessorFingerprint = 'win32-cim:2026-07-23T12:34:56.1234567Z';
  const result = await killProcessGroupOwnedByStack(4242, {
    stackName: 't',
    envPath: 'C:\\stack\\env',
    json: true,
    platform: 'win32',
    processInstanceFingerprint: predecessorFingerprint,
    readProcessInstanceFingerprintSyncImpl: (_pid, options) => (
      options?.expectedFingerprint === predecessorFingerprint
        ? predecessorFingerprint
        : 'win32-cim:jeudi 23 juillet 2026 14:34:56'
    ),
    getProcessGroupIdImpl: async () => { throw new Error('Windows must not require POSIX PGID'); },
    terminateProcessGroupImpl: async (pid, options) => {
      calls.push({ pid, options });
      return { ok: true, signal: 'SIGKILL' };
    },
  });

  assert.equal(result.killed, true);
  assert.equal(result.reason, 'killed_tree');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, 4242);
  assert.equal(calls[0].options.identityPid, 4242);
  assert.equal(calls[0].options.processInstanceFingerprint, predecessorFingerprint);
});

test('killProcessGroupOwnedByStack fails closed on Windows without persisted incarnation proof', async () => {
  let terminateCalls = 0;
  const result = await killProcessGroupOwnedByStack(4242, {
    stackName: 't',
    envPath: 'C:\\stack\\env',
    json: true,
    platform: 'win32',
    observePidLivenessImpl: () => ({ status: 'alive' }),
    readProcessInstanceFingerprintSyncImpl: () => 'win32-cim:current',
    terminateProcessGroupImpl: async () => {
      terminateCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(result.killed, false);
  assert.equal(result.reason, 'process_instance_unavailable');
  assert.equal(terminateCalls, 0);
});

test('killProcessGroupOwnedByStack snapshots and rechecks a POSIX incarnation around ownership proof', async () => {
  const calls = [];
  let fingerprintReads = 0;
  const result = await killProcessGroupOwnedByStack(4242, {
    stackName: 't',
    envPath: '/tmp/t/env',
    json: true,
    platform: 'linux',
    readProcessInstanceFingerprintSyncImpl: () => {
      fingerprintReads += 1;
      return 'linux-proc:1234';
    },
    resolvePidStackOwnershipImpl: async () => ({ owned: true, reason: 'env_file' }),
    getProcessGroupIdImpl: async (pid) => Number(pid) === process.pid ? 9999 : 4242,
    terminateProcessGroupImpl: async (pid, options) => {
      calls.push({ pid, options });
      return { ok: true, signal: 'SIGTERM' };
    },
  });

  assert.equal(result.killed, true);
  assert.equal(fingerprintReads >= 2, true);
  assert.equal(calls[0].options.identityPid, 4242);
  assert.equal(calls[0].options.processInstanceFingerprint, 'linux-proc:1234');
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
