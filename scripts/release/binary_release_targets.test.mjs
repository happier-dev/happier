import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_STACK_TARGETS, resolveTargets } from './lib/binary_release.mjs';

test('resolveTargets returns all targets when filter is empty', () => {
  const targets = resolveTargets({ availableTargets: CLI_STACK_TARGETS, requested: '' });
  assert.equal(targets.length, CLI_STACK_TARGETS.length);
});

test('resolveTargets supports comma separated os-arch filters', () => {
  const targets = resolveTargets({ availableTargets: CLI_STACK_TARGETS, requested: 'linux-x64,darwin-arm64' });
  assert.deepEqual(
    targets.map((target) => `${target.os}-${target.arch}`),
    ['linux-x64', 'darwin-arm64']
  );
});

test('resolveTargets throws for unknown requested targets', () => {
  assert.throws(() => {
    resolveTargets({ availableTargets: CLI_STACK_TARGETS, requested: 'linux-ppc64' });
  }, /unknown target/);
});
