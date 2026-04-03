import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReactNativeDevtoolsUrl } from './react_native_devtools.mjs';

test('resolveReactNativeDevtoolsUrl defaults to /debugger-ui', () => {
  const url = resolveReactNativeDevtoolsUrl({ metroUrl: 'http://localhost:8081' });
  assert.equal(url, 'http://localhost:8081/debugger-ui');
});

test('resolveReactNativeDevtoolsUrl respects HAPPIER_STACK_RN_DEVTOOLS_PATH', () => {
  const url = resolveReactNativeDevtoolsUrl({
    metroUrl: 'http://localhost:8081',
    env: { ...process.env, HAPPIER_STACK_RN_DEVTOOLS_PATH: '/_expo/debugger-ui' },
  });
  assert.equal(url, 'http://localhost:8081/_expo/debugger-ui');
});

test('resolveReactNativeDevtoolsUrl normalizes missing leading slash', () => {
  const url = resolveReactNativeDevtoolsUrl({
    metroUrl: 'http://localhost:8081',
    env: { ...process.env, HAPPIER_STACK_RN_DEVTOOLS_PATH: 'debugger-ui' },
  });
  assert.equal(url, 'http://localhost:8081/debugger-ui');
});

