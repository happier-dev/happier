import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMobileReachableServerUrl } from './mobile_api_url.mjs';

test('resolveMobileReachableServerUrl rewrites localhost to LAN IP (env override)', () => {
  const out = resolveMobileReachableServerUrl({
    env: { HAPPIER_STACK_LAN_IP: '192.168.0.50' },
    serverUrl: 'http://localhost:3005',
    serverPort: 3005,
  });
  assert.equal(out, 'http://192.168.0.50:3005');
});

test('resolveMobileReachableServerUrl rewrites *.localhost to LAN IP (env override)', () => {
  const out = resolveMobileReachableServerUrl({
    env: { HAPPIER_STACK_LAN_IP: '10.0.0.12' },
    serverUrl: 'http://happy-exp1.localhost:3009/',
    serverPort: 3009,
  });
  assert.equal(out, 'http://10.0.0.12:3009');
});

test('resolveMobileReachableServerUrl preserves path and query', () => {
  const out = resolveMobileReachableServerUrl({
    env: { HAPPIER_STACK_LAN_IP: '10.0.0.12' },
    serverUrl: 'http://127.0.0.1:3005/api?x=1',
    serverPort: 3005,
  });
  assert.equal(out, 'http://10.0.0.12:3005/api?x=1');
});

test('resolveMobileReachableServerUrl does not rewrite non-local URLs', () => {
  const out = resolveMobileReachableServerUrl({
    env: { HAPPIER_STACK_LAN_IP: '192.168.0.50' },
    serverUrl: 'https://my-machine.tailnet.ts.net',
    serverPort: 3005,
  });
  assert.equal(out, 'https://my-machine.tailnet.ts.net');
});
