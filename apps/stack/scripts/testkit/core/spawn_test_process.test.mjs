import test from 'node:test';
import assert from 'node:assert/strict';

import { spawnDetachedInlineNodeTestProcess, spawnTestProcess } from './spawn_test_process.mjs';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test('spawnTestProcess exposes a pid', async () => {
  const child = spawnTestProcess(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  });

  assert.equal(typeof child.pid, 'number');

  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      assert.equal(code, 0);
      resolve();
    });
  });
});

test('spawnDetachedInlineNodeTestProcess launches a detached fixture process', async () => {
  const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)');
  assert.equal(typeof child.pid, 'number');
  assert.equal(isPidAlive(child.pid), true);

  try {
    process.kill(child.pid, 'SIGTERM');
  } catch {
    // ignore
  }

  assert.equal(await waitForProcessExit(child.pid), true);
});
