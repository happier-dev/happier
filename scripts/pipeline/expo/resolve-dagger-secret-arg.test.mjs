// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDaggerSecretArg } from './resolve-dagger-secret-arg.mjs';

test('resolveDaggerSecretArg encodes env secret references using env:<NAME>', () => {
  assert.equal(resolveDaggerSecretArg('EXPO_TOKEN'), 'env:EXPO_TOKEN');
  assert.equal(resolveDaggerSecretArg('SENTRY_AUTH_TOKEN'), 'env:SENTRY_AUTH_TOKEN');
});

