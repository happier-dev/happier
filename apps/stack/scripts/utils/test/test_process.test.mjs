import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNodeTestArgs } from './test_process.mjs';

test('buildNodeTestArgs preserves native node --test file execution for unit lanes', () => {
  assert.deepEqual(buildNodeTestArgs(['/tmp/a.test.mjs', '/tmp/b.test.mjs']), [
    '--test',
    '/tmp/a.test.mjs',
    '/tmp/b.test.mjs',
  ]);
});

test('buildNodeTestArgs adds serial concurrency flag only when requested', () => {
  assert.deepEqual(buildNodeTestArgs(['/tmp/a.integration.test.mjs'], { serial: true }), [
    '--test',
    '--test-concurrency=1',
    '/tmp/a.integration.test.mjs',
  ]);
});
