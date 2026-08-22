import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStackCleanupExecutorLockTimeoutMs } from './stop.mjs';

test('attended TUI cleanup lock waits use checkpoints instead of a terminal deadline', () => {
  assert.equal(resolveStackCleanupExecutorLockTimeoutMs({ env: { HAPPIER_STACK_TUI: '1' } }), Infinity);
  assert.equal(resolveStackCleanupExecutorLockTimeoutMs({ env: {} }), 300_000);
  assert.equal(resolveStackCleanupExecutorLockTimeoutMs(
    { env: { HAPPIER_STACK_TUI: '1' } },
    { timeoutMs: 12_345 },
  ), 12_345);
});
