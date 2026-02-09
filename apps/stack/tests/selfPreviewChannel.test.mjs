import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfUpdateHarness } from './testkit/self_update_testkit.mjs';

test('hstack self check --preview uses npm dist-tag next', (t) => {
  const harness = createSelfUpdateHarness(t, { prefix: 'hstack-preview-check-' });
  const res = harness.runSelfCommand(['check', '--preview', '--quiet']);
  assert.equal(res.status, 0);

  const log = harness.readNpmArgsLog();
  assert.ok(log.includes('view @happier-dev/stack@next version'));
});

test('hstack self update --preview installs @next when --to is not provided', (t) => {
  const harness = createSelfUpdateHarness(t, { prefix: 'hstack-preview-update-' });
  const res = harness.runSelfCommand(['update', '--preview', '--json']);
  assert.equal(res.status, 0);

  const log = harness.readNpmArgsLog();
  assert.ok(log.includes('install'));
  assert.ok(log.includes('@happier-dev/stack@next'));
});

test('hstack self update --preview honors explicit --to version over channel tag', (t) => {
  const harness = createSelfUpdateHarness(t, { prefix: 'hstack-preview-update-to-' });
  const res = harness.runSelfCommand(['update', '--preview', '--to=1.2.3', '--json']);
  assert.equal(res.status, 0);

  const log = harness.readNpmArgsLog();
  const installLine = log
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('install '));
  assert.ok(installLine, `expected install command line in npm log\n${log}`);
  assert.ok(installLine.includes('@happier-dev/stack@1.2.3'), `expected explicit --to spec in install line\n${installLine}`);
  assert.ok(!installLine.includes('@happier-dev/stack@next'), `expected install line to avoid preview dist-tag\n${installLine}`);
});
