import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPidsWithEnvNeedles } from './ownership.mjs';

function spawnOwnedSleep({ env }) {
  const cleanEnv = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v == null) continue;
    cleanEnv[k] = String(v);
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: cleanEnv,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ignore
  }
}

async function waitForPidsWithRetries({ needles, matchPid, timeoutMs = 1500, intervalMs = 40 }) {
  const end = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let last = [];
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    last = await listPidsWithEnvNeedles(needles);
    if (last.includes(matchPid)) return last;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `timed out waiting for pid ${matchPid} with needles ${JSON.stringify(needles)}; last seen pids=${JSON.stringify(last)}`
  );
}

test('listPidsWithEnvNeedles requires all needles to match', async (t) => {
  if (process.platform === 'win32') {
    t.skip('requires ps eww support');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-needles-'));
  const envPath = join(tmp, 'env');

  const infra = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 't',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  });
  const session = spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 't',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  });

  try {
    assert.ok(Number(infra.pid) > 1, 'expected infra pid');
    assert.ok(Number(session.pid) > 1, 'expected session pid');

    const needles = [
      `HAPPIER_STACK_ENV_FILE=${envPath}`,
      'HAPPIER_STACK_PROCESS_KIND=infra',
    ];
    const pids = await waitForPidsWithRetries({
      needles,
      matchPid: infra.pid,
    });
    assert.ok(pids.includes(infra.pid), `expected infra pid ${infra.pid} in results`);
    assert.ok(!pids.includes(session.pid), `expected session pid ${session.pid} to be excluded`);
  } finally {
    killGroup(infra.pid);
    killGroup(session.pid);
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
