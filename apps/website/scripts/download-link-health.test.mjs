import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDownloadLinkStatus } from './download-link-health.mjs';

test('download link health fails only on definitive HTTP client errors', () => {
  assert.equal(classifyDownloadLinkStatus(200), 'ok');
  assert.equal(classifyDownloadLinkStatus(302), 'ok');
  assert.equal(classifyDownloadLinkStatus(404), 'fail');
  assert.equal(classifyDownloadLinkStatus(410), 'fail');
});

test('download link health treats provider throttling and outages as inconclusive', () => {
  assert.equal(classifyDownloadLinkStatus(408), 'warn');
  assert.equal(classifyDownloadLinkStatus(425), 'warn');
  assert.equal(classifyDownloadLinkStatus(429), 'warn');
  assert.equal(classifyDownloadLinkStatus(500), 'warn');
  assert.equal(classifyDownloadLinkStatus(503), 'warn');
  assert.equal(classifyDownloadLinkStatus('fetch failed'), 'warn');
});
