import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchGitHubReleaseByTag, fetchFirstGitHubReleaseByTags } from '../dist/github.js';

function createFetchStub(routeMap) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? null });
    const route = routeMap.get(String(url));
    if (!route) {
      return {
        ok: false,
        status: 500,
        statusText: 'no route',
        json: async () => ({}),
        text: async () => '',
      };
    }
    return {
      ok: route.ok,
      status: route.status,
      statusText: route.statusText ?? '',
      json: async () => route.json ?? {},
      text: async () => route.text ?? '',
    };
  };
  return { fetch, calls };
}

test('fetchGitHubReleaseByTag calls GitHub tag endpoint and returns JSON', async () => {
  const url = 'https://api.github.com/repos/happier-dev/happier/releases/tags/server-preview';
  const routeMap = new Map([
    [url, { ok: true, status: 200, json: { tag_name: 'server-preview', assets: [] } }],
  ]);
  const stub = createFetchStub(routeMap);

  const release = await fetchGitHubReleaseByTag({
    githubRepo: 'happier-dev/happier',
    tag: 'server-preview',
    fetchImpl: stub.fetch,
    userAgent: 'test-agent',
  });

  assert.equal(release.tag_name, 'server-preview');
  assert.equal(stub.calls[0].url, url);
  assert.match(String(stub.calls[0].init.headers['user-agent'] ?? ''), /test-agent/);
});

test('fetchGitHubReleaseByTag throws with status for non-ok responses', async () => {
  const url = 'https://api.github.com/repos/happier-dev/happier/releases/tags/missing';
  const routeMap = new Map([
    [url, { ok: false, status: 404, json: { message: 'Not Found' } }],
  ]);
  const stub = createFetchStub(routeMap);

  try {
    await fetchGitHubReleaseByTag({
      githubRepo: 'happier-dev/happier',
      tag: 'missing',
      fetchImpl: stub.fetch,
    });
    assert.fail('expected fetchGitHubReleaseByTag to throw');
  } catch (e) {
    assert.equal(Number(e?.status), 404);
  }
});

test('fetchFirstGitHubReleaseByTags returns first non-404 release', async () => {
  const u1 = 'https://api.github.com/repos/happier-dev/happier/releases/tags/ui-web-preview';
  const u2 = 'https://api.github.com/repos/happier-dev/happier/releases/tags/ui-web-stable';
  const routeMap = new Map([
    [u1, { ok: false, status: 404, json: { message: 'Not Found' } }],
    [u2, { ok: true, status: 200, json: { tag_name: 'ui-web-stable' } }],
  ]);
  const stub = createFetchStub(routeMap);

  const resolved = await fetchFirstGitHubReleaseByTags({
    githubRepo: 'happier-dev/happier',
    tags: ['ui-web-preview', 'ui-web-stable'],
    fetchImpl: stub.fetch,
  });

  assert.equal(resolved.tag, 'ui-web-stable');
  assert.equal(resolved.release.tag_name, 'ui-web-stable');
  assert.equal(stub.calls.length, 2);
});

