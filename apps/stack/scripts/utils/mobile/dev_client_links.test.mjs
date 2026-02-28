import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMobileQrPayload } from './dev_client_links.mjs';

test('resolveMobileQrPayload uses the configured app scheme for the dev-client deep link', () => {
  const env = {
    HAPPIER_STACK_MOBILE_HOST: 'localhost',
    EXPO_APP_SCHEME: 'happier-dev',
  };

  const { metroUrl, deepLink, payload } = resolveMobileQrPayload({ env, port: 8081 });
  assert.equal(metroUrl, 'http://localhost:8081');
  assert.equal(deepLink, `happier-dev://expo-development-client/?url=${encodeURIComponent(metroUrl)}`);
  assert.equal(payload, deepLink);
});

test('resolveMobileQrPayload does not require EXPO_APP_SLUG', () => {
  const env = {
    HAPPIER_STACK_MOBILE_HOST: 'localhost',
    EXPO_APP_SCHEME: 'happier-dev',
    EXPO_APP_SLUG: undefined,
  };

  const { metroUrl, deepLink } = resolveMobileQrPayload({ env, port: 8081 });
  assert.equal(metroUrl, 'http://localhost:8081');
  assert.equal(deepLink, `happier-dev://expo-development-client/?url=${encodeURIComponent(metroUrl)}`);
});
