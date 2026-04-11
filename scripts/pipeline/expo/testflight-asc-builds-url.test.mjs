import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAscBuildsListUrl } from './testflight-asc-builds-url.mjs';

test('buildAscBuildsListUrl keeps the builds collection query shape', () => {
  const url = new URL(buildAscBuildsListUrl({ ascAppId: '123456789' }));
  assert.equal(url.pathname, '/v1/builds');
  assert.equal(url.searchParams.get('filter[app]'), '123456789');
  assert.equal(url.searchParams.get('include'), 'preReleaseVersion,betaGroups,betaAppReviewSubmission');
  assert.equal(url.searchParams.get('limit'), '200');
});

test('buildAscBuildsListUrl respects explicit limits', () => {
  const url = new URL(buildAscBuildsListUrl({ ascAppId: '123456789', limit: 50 }));
  assert.equal(url.searchParams.get('limit'), '50');
});
