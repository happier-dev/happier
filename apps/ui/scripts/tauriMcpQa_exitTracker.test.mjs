import test from 'node:test';
import assert from 'node:assert/strict';

import { createTauriMcpQaExitTracker } from './tauriMcpQa.mjs';

test('exit tracker waits for both processes to exit cleanly', () => {
  const tracker = createTauriMcpQaExitTracker();

  assert.equal(tracker.onChildExit('tauri', 0, null), null);
  assert.equal(tracker.onChildExit('mcp', 0, null), 0);
});

test('exit tracker settles when any child exits non-zero', () => {
  const tracker = createTauriMcpQaExitTracker();

  assert.equal(tracker.onChildExit('tauri', 1, null), 1);
});

test('exit tracker settles when any child exits due to a signal', () => {
  const tracker = createTauriMcpQaExitTracker();

  const res = tracker.onChildExit('tauri', 0, 'SIGTERM');
  assert.equal(res, 143);
});

