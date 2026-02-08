import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { isPidAlive } from './pids.mjs';
import { terminateProcessGroup } from './terminate.mjs';

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

  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        "process.on('SIGINT', () => {});",
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join(' '),
    ],
    { stdio: 'ignore', detached: true }
  );
  child.unref();
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
