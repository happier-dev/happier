import test from 'node:test';
import assert from 'node:assert/strict';

import { requiresStackDaemonPreflight } from './stack_happier_daemon_preflight.mjs';

test('requiresStackDaemonPreflight skips daemon preflight for session create help paths', () => {
  assert.equal(requiresStackDaemonPreflight(['session', 'create', '--help']), false);
  assert.equal(requiresStackDaemonPreflight(['session', 'create', '-h']), false);
});

test('requiresStackDaemonPreflight keeps daemon preflight for executable session and attach paths', () => {
  assert.equal(requiresStackDaemonPreflight(['session', 'create']), true);
  assert.equal(requiresStackDaemonPreflight(['resume']), true);
  assert.equal(requiresStackDaemonPreflight(['attach']), true);
});
