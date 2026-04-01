// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDaggerSecretArg } from './resolve-dagger-secret-arg.mjs';

test('resolveDaggerSecretArg encodes env secret references using env://<NAME>', () => {
  const expo = resolveDaggerSecretArg('EXPO_TOKEN');
  const sentry = resolveDaggerSecretArg('SENTRY_AUTH_TOKEN');

  assert.equal(expo, 'env://EXPO_TOKEN');
  assert.equal(sentry, 'env://SENTRY_AUTH_TOKEN');
});
