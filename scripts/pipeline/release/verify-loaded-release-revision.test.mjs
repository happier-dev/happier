import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyLoadedReleaseRevision } from './verify-loaded-release-revision.mjs';

const sha = 'a'.repeat(40);

test('loaded revision verifier accepts only the exact runtime source SHA', async () => {
  const result = await verifyLoadedReleaseRevision({
    url: 'https://api.example.test/v1/version',
    expectedSourceSha: sha,
    attempts: 1,
    intervalMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, source_sha: sha }), { status: 200 }),
  });
  assert.equal(result.sourceSha, sha);
});

test('loaded revision verifier fails closed without exact runtime evidence', async () => {
  await assert.rejects(verifyLoadedReleaseRevision({
    url: 'https://api.example.test/v1/version',
    expectedSourceSha: sha,
    attempts: 1,
    intervalMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  }), /did not report the expected source SHA/i);
});
