import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_STACK_TARGETS, SERVER_TARGETS, resolveTargets } from '../pipeline/release/lib/binary-release.mjs';

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

test('SERVER_TARGETS covers linux/darwin/windows defaults', () => {
  const targets = resolveTargets({ availableTargets: SERVER_TARGETS, requested: '' });
  const set = new Set(targets.map((t) => `${t.os}-${t.arch}`));
  assert.ok(set.has('linux-x64'));
  assert.ok(set.has('linux-arm64'));
  assert.ok(set.has('darwin-x64'));
  assert.ok(set.has('darwin-arm64'));
  assert.ok(set.has('windows-x64'));
});
