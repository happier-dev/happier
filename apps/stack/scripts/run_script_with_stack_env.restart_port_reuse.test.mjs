import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasRecordedRuntimePortsForRestart,
  shouldReuseRuntimePortsOnRestart,
} from './stack/run_script_with_stack_env.mjs';

test('hasRecordedRuntimePortsForRestart requires a positive server port', () => {
  assert.equal(hasRecordedRuntimePortsForRestart(null), false);
  assert.equal(hasRecordedRuntimePortsForRestart({ ports: {} }), false);
  assert.equal(hasRecordedRuntimePortsForRestart({ ports: { server: '0' } }), false);
  assert.equal(hasRecordedRuntimePortsForRestart({ ports: { server: '3010' } }), true);
});

test('shouldReuseRuntimePortsOnRestart reuses runtime ports on stale-owner restarts', () => {
  const runtimeState = { ownerPid: 999_999_999, ports: { server: 3010 } };
  assert.equal(
    shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState, wasRunning: false }),
    true
  );
});

test('shouldReuseRuntimePortsOnRestart stays false when restart was not requested', () => {
  const runtimeState = { ports: { server: 3010 } };
  assert.equal(
    shouldReuseRuntimePortsOnRestart({ wantsRestart: false, runtimeState, wasRunning: true }),
    false
  );
});
