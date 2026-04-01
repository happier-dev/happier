import test from 'node:test';
import assert from 'node:assert/strict';

import { assertDockerChannel, isDockerChannel } from './docker-channels.mjs';

test('isDockerChannel returns true for stable/preview/dev', () => {
  assert.equal(isDockerChannel('stable'), true);
  assert.equal(isDockerChannel('preview'), true);
  assert.equal(isDockerChannel('dev'), true);
});

test('isDockerChannel returns false for unknown values', () => {
  assert.equal(isDockerChannel('production'), false);
  assert.equal(isDockerChannel(''), false);
  assert.equal(isDockerChannel('canary'), false);
});

test('assertDockerChannel returns the channel when valid', () => {
  assert.equal(assertDockerChannel('stable'), 'stable');
  assert.equal(assertDockerChannel('preview'), 'preview');
  assert.equal(assertDockerChannel('dev'), 'dev');
});

test('assertDockerChannel throws for invalid channels', () => {
  assert.throws(() => assertDockerChannel('production'), /docker channel/i);
});

