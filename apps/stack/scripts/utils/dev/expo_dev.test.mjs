import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExpoDevEnv, buildExpoStartArgs, resolveExpoDevHost } from './expo_dev.mjs';

test('resolveExpoDevHost defaults to lan and normalizes values', () => {
  assert.equal(resolveExpoDevHost({ env: {} }), 'lan');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: 'LAN' } }), 'lan');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: '  TuNnEl  ' } }), 'tunnel');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: 'localhost' } }), 'localhost');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: 'tunnel' } }), 'tunnel');
  assert.equal(resolveExpoDevHost({ env: { HAPPIER_STACK_EXPO_HOST: 'nope' } }), 'lan');
});

test('buildExpoDevEnv enables Expo Router web modal support', () => {
  const env = buildExpoDevEnv({
    baseEnv: { EXPO_UNSTABLE_WEB_MODAL: '0' },
    apiServerUrl: 'http://127.0.0.1:4000',
    wantDevClient: false,
    wantWeb: true,
  });

  assert.equal(env.EXPO_UNSTABLE_WEB_MODAL, '1');
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

test('buildExpoStartArgs accepts numeric port strings and does not add --clear when disabled', () => {
  const args = buildExpoStartArgs({
    port: '8082',
    host: 'localhost',
    wantWeb: true,
    wantDevClient: false,
    scheme: '',
    clearCache: false,
  });
  assert.deepEqual(args, ['start', '--web', '--host', 'localhost', '--port', '8082']);
  assert.equal(args.includes('--clear'), false);
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
