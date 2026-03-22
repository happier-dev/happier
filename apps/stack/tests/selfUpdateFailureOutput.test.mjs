import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfUpdateHarness } from './testkit/self_update_testkit.mjs';

test('hstack self update prints a concise failure message without stack trace noise', (t) => {
  const harness = createSelfUpdateHarness(t, {
    prefix: 'hstack-self-update-fail-',
    installExitCode: 42,
    installStderr: 'fake install failure\n',
  });
  const res = harness.runSelfCommand(['update', '--json']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /\[self\] failed: npm install exited with status 42/i);
  assert.doesNotMatch(res.stderr, /\n\s*at\s+/i);
});
