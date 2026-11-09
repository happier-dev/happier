import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCredentialRequestRedirect } from '../dist/httpRedirects.js';

test('redirects compare private header names case-insensitively and retain same-origin credentials', () => {
  const headers = { 'X-Private-Token': 'fixture-private', 'x-public': 'public' };
  const request = {
    status: 307,
    requestUrl: 'https://source.example.test/start',
    method: 'GET',
    headers,
    hasSecretBody: false,
    privateCredentialHeaderNames: new Set(['X-PRIVATE-TOKEN']),
  };
  const crossOrigin = resolveCredentialRequestRedirect({ ...request, location: 'https://other.example.test/next' });
  assert.deepEqual(crossOrigin?.headers, { 'x-public': 'public' });
  const sameOrigin = resolveCredentialRequestRedirect({ ...request, location: '/next' });
  assert.deepEqual(sameOrigin?.headers, headers);
});
