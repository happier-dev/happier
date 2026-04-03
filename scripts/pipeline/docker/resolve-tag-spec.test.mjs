import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDockerTagSpec } from './resolve-tag-spec.mjs';

test('resolveDockerTagSpec returns stable tag spec', () => {
  assert.deepEqual(resolveDockerTagSpec('stable'), {
    channelTag: 'stable',
    floatTag: 'latest',
    policyEnv: 'production',
  });
});

test('resolveDockerTagSpec returns preview tag spec', () => {
  assert.deepEqual(resolveDockerTagSpec('preview'), {
    channelTag: 'preview',
    floatTag: 'preview',
    policyEnv: 'preview',
  });
});

test('resolveDockerTagSpec returns dev tag spec', () => {
  assert.deepEqual(resolveDockerTagSpec('dev'), {
    channelTag: 'dev',
    floatTag: 'dev',
    policyEnv: 'preview',
  });
});

test('resolveDockerTagSpec throws for unknown channels', () => {
  assert.throws(() => resolveDockerTagSpec('production'), /channel/i);
});

