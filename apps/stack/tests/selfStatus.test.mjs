import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfUpdateHarness } from './testkit/self_update_testkit.mjs';

test('hstack self status --json works without kv shadowing crash', (t) => {
  const harness = createSelfUpdateHarness(t, { prefix: 'hstack-self-status-' });
  const res = harness.runSelfCommand(['status', '--no-check', '--json']);
  assert.equal(res.status, 0);
  assert.doesNotThrow(() => JSON.parse(res.stdout));
});
