import assert from 'node:assert/strict';
import test from 'node:test';

import { runManagedChildCommand } from './managedChildLifecycle.mjs';

test('runManagedChildCommand terminates and reports a timed-out child', async () => {
  const startedAt = Date.now();
  const result = await runManagedChildCommand({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 100,
    cleanupPollMs: 10,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 100,
    spawnOptions: { stdio: 'ignore' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(Date.now() - startedAt < 5_000, 'the child deadline should settle promptly');
});
