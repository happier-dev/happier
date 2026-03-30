import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldRunRealIntegrationTests, splitRealIntegrationTests } from './integration_test_runner.mjs';

test('shouldRunRealIntegrationTests defaults to false', () => {
  assert.equal(shouldRunRealIntegrationTests({}), false);
});

test('shouldRunRealIntegrationTests enables real tests when env var is truthy', () => {
  for (const value of ['1', 'true', 'yes', 'y', 'on']) {
    assert.equal(shouldRunRealIntegrationTests({ HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS: value }), true);
  }
});

test('shouldRunRealIntegrationTests disables real tests when env var is falsy', () => {
  for (const value of ['0', 'false', 'no', 'n', 'off', '']) {
    assert.equal(shouldRunRealIntegrationTests({ HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS: value }), false);
  }
});

test('splitRealIntegrationTests splits real integration suffixes', () => {
  const files = [
    '/tmp/a.integration.test.mjs',
    '/tmp/b.real.integration.test.mjs',
    '/tmp/not-a-test.mjs',
    '/tmp/c.integration.test.mjs',
    '/tmp/d.real.integration.test.mjs',
    '/tmp/unit.test.mjs',
  ];
  const { regular, real } = splitRealIntegrationTests(files);
  assert.deepEqual(regular, ['/tmp/a.integration.test.mjs', '/tmp/c.integration.test.mjs']);
  assert.deepEqual(real, ['/tmp/b.real.integration.test.mjs', '/tmp/d.real.integration.test.mjs']);
});

test('shouldRunRealIntegrationTests trims and lowercases env values', () => {
  assert.equal(shouldRunRealIntegrationTests({ HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS: '  TrUe  ' }), true);
});

test('shouldRunRealIntegrationTests falls back on unknown values', () => {
  assert.equal(shouldRunRealIntegrationTests({ HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS: 'maybe' }), false);
});
