import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExpoStartArgs, resolveExpoDevHost } from './expo_dev.mjs';

test('resolveExpoDevHost defaults to lan and normalizes values', () => {
  assert.equal(resolveExpoDevHost({ env: {} }), 'lan');
  assert.equal(resolveExpoDevHost({ env: { HAPPY_STACKS_EXPO_HOST: 'LAN' } }), 'lan');
  assert.equal(resolveExpoDevHost({ env: { HAPPY_STACKS_EXPO_HOST: 'localhost' } }), 'localhost');
  assert.equal(resolveExpoDevHost({ env: { HAPPY_STACKS_EXPO_HOST: 'tunnel' } }), 'tunnel');
  assert.equal(resolveExpoDevHost({ env: { HAPPY_STACKS_EXPO_HOST: 'nope' } }), 'lan');
});

test('buildExpoStartArgs builds dev-client args (preferred when mobile enabled)', () => {
  const args = buildExpoStartArgs({
    port: 8081,
    host: 'lan',
    wantWeb: true,
    wantDevClient: true,
    scheme: 'happy',
    clearCache: true,
  });
  assert.deepEqual(args, ['start', '--dev-client', '--host', 'lan', '--port', '8081', '--scheme', 'happy', '--clear']);
});

test('buildExpoStartArgs builds web args when dev-client is not requested', () => {
  const args = buildExpoStartArgs({
    port: 8081,
    host: 'lan',
    wantWeb: true,
    wantDevClient: false,
    scheme: '',
    clearCache: false,
  });
  assert.deepEqual(args, ['start', '--web', '--host', 'lan', '--port', '8081']);
});

test('buildExpoStartArgs omits --scheme when empty', () => {
  const args = buildExpoStartArgs({
    port: 8081,
    host: 'lan',
    wantWeb: false,
    wantDevClient: true,
    scheme: '',
    clearCache: false,
  });
  assert.deepEqual(args, ['start', '--dev-client', '--host', 'lan', '--port', '8081']);
});

test('buildExpoStartArgs throws on invalid requests', () => {
  assert.throws(
    () =>
      buildExpoStartArgs({
        port: 0,
        host: 'lan',
        wantWeb: true,
        wantDevClient: false,
        scheme: '',
        clearCache: false,
      }),
    /invalid Metro port/i
  );
  assert.throws(
    () =>
      buildExpoStartArgs({
        port: 8081,
        host: 'lan',
        wantWeb: false,
        wantDevClient: false,
        scheme: '',
        clearCache: false,
      }),
    /neither web nor dev-client requested/i
  );
});

