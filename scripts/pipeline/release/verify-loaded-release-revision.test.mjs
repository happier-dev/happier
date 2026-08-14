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
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, source_sha: sha }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  assert.deepEqual(result, { url: 'https://api.example.test/v1/version', sourceSha: sha, attempts: 1 });
});

test('loaded revision verifier retries stale deployments and then converges', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await verifyLoadedReleaseRevision({
    url: 'https://api.example.test/v1/version',
    expectedSourceSha: sha,
    attempts: 2,
    intervalMs: 25,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, source_sha: calls === 1 ? 'b'.repeat(40) : sha }), { status: 200 });
    },
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [25]);
});

test('loaded revision verifier fails closed when the endpoint never proves the candidate', async () => {
  await assert.rejects(
    verifyLoadedReleaseRevision({
      url: 'https://api.example.test/v1/version',
      expectedSourceSha: sha,
      attempts: 1,
      intervalMs: 0,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
    /did not report the expected source SHA/i,
  );
});
