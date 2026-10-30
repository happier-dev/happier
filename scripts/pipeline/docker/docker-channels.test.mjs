import test from 'node:test';
import assert from 'node:assert/strict';

import { isDockerChannel } from './docker-channels.mjs';

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

