import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fetchGitHubLatestRelease, fetchGitHubReleaseByTag, fetchFirstGitHubReleaseByTags } from '../dist/github.js';

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

for (const kind of ['tag', 'latest', 'assets']) {
  test(`public ${kind} release lookup accepts a browser fetch with its native receiver contract`, async () => {
    // Native Window.fetch rejects a foreign receiver before issuing any request.
    async function browserFetch() {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return kind === 'assets'
        ? new Response('<li><a href="/happier-dev/happier/releases/download/cli-stable/cli.tar.gz">cli</a></li>')
        : Response.json({ tag_name: 'cli-stable', assets: [] });
    }
    const params = { githubRepo: 'happier-dev/happier', tag: 'cli-stable', fetchImpl: browserFetch };
    const release = kind === 'latest' ? await fetchGitHubLatestRelease(params)
      : await fetchGitHubReleaseByTag({ ...params, assetsOnly: kind === 'assets' });
    assert.equal(release.tag_name, 'cli-stable');
  });
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

test('fetchGitHubReleaseByTag forwards cancellation to the release HTTP boundary', async () => {
  const url = 'https://api.github.com/repos/happier-dev/happier/releases/tags/runner-v0.3.0';
  const routeMap = new Map([
    [url, { ok: true, status: 200, json: { tag_name: 'runner-v0.3.0', assets: [] } }],
  ]);
  const stub = createFetchStub(routeMap);
  const controller = new AbortController();

  await fetchGitHubReleaseByTag({
    githubRepo: 'happier-dev/happier',
    tag: 'runner-v0.3.0',
    fetchImpl: stub.fetch,
    signal: controller.signal,
  });

  assert.equal(stub.calls[0].init.signal, controller.signal);
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

test('fetchGitHubReleaseByTag tolerates the bounded rolling-release replacement gap', async () => {
  let calls = 0;
  const release = await fetchGitHubReleaseByTag({
    githubRepo: 'happier-dev/happier',
    tag: 'server-preview',
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls < 3
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ tag_name: 'server-preview' }) };
    },
  });
  assert.equal(calls, 3);
  assert.equal(release.tag_name, 'server-preview');
});

test('fetchGitHubReleaseByTag preserves the network failure cause for acquisition diagnostics', async () => {
  const networkError = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
  await assert.rejects(fetchGitHubReleaseByTag({
    githubRepo: 'happier-dev/happier',
    tag: 'cli-stable',
    fetchImpl: async () => { throw networkError; },
  }), (error) => {
    assert.equal(error.cause, networkError);
    return true;
  });
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

test('fetchFirstGitHubReleaseByTags falls back when the HTTP boundary throws a 404 error', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? null });
    if (href.endsWith('/releases/tags/ui-web-preview')) {
      throw new Error(`[http] request failed: ${href} (404)`);
    }
    if (href.endsWith('/releases/tags/ui-web-stable')) {
      return {
        ok: true,
        status: 200,
        statusText: 'ok',
        json: async () => ({ tag_name: 'ui-web-stable' }),
        text: async () => '',
      };
    }
    return {
      ok: false,
      status: 500,
      statusText: 'no route',
      json: async () => ({}),
      text: async () => '',
    };
  };

  const resolved = await fetchFirstGitHubReleaseByTags({
    githubRepo: 'happier-dev/happier',
    tags: ['ui-web-preview', 'ui-web-stable'],
    fetchImpl: fetch,
  });

  assert.equal(resolved.tag, 'ui-web-stable');
  assert.equal(resolved.release.tag_name, 'ui-web-stable');
  assert.equal(calls.length, 2);
});

test('fetchGitHubLatestRelease calls GitHub latest endpoint and returns JSON', async () => {
  const url = 'https://api.github.com/repos/zed-industries/codex-acp/releases/latest';
  const routeMap = new Map([
    [url, { ok: true, status: 200, json: { tag_name: 'v0.9.5', assets: [] } }],
  ]);
  const stub = createFetchStub(routeMap);

  const release = await fetchGitHubLatestRelease({
    githubRepo: 'zed-industries/codex-acp',
    fetchImpl: stub.fetch,
    userAgent: 'test-agent',
  });

  assert.equal(release.tag_name, 'v0.9.5');
  assert.equal(stub.calls[0].url, url);
  assert.match(String(stub.calls[0].init.headers['user-agent'] ?? ''), /test-agent/);
});

test('GitHub rate-limit failures retain their reset time through fetch', async () => {
  const resetAtMs = 1792364400000;
  for (const status of [403, 429]) {
    for (const read of [fetchGitHubLatestRelease, (params) => fetchGitHubReleaseByTag({ ...params, tag: 'v1' })]) {
      await assert.rejects(read({
        githubRepo: 'acme/tool',
        fetchImpl: async () => new Response('', { status, headers: {
          'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAtMs / 1000),
        } }),
      }), (error) => {
        assert.equal(error.code, 'github_rate_limited');
        assert.equal(error.resetAtMs, resetAtMs);
        assert.equal(error.status, status);
        assert.match(error.message, /2026-10-18T23:00:00.000Z/);
        return true;
      });
    }
  }
});

test('Node HTTP retains an exhausted GitHub rate-limit response without retrying it', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792364400' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(fetchGitHubReleaseByTag({
      githubRepo: 'acme/tool', tag: 'v1', apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
    }), (error) => {
      assert.equal(error.code, 'github_rate_limited');
      assert.equal(error.resetAtMs, 1792364400000);
      assert.equal(requests, 1);
      return true;
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('asset-only pinned resolution reads public downloads and row-bound digests without API credentials', async () => {
  const requests = [];
  const release = await fetchGitHubReleaseByTag({
    githubRepo: 'openai/codex', tag: 'rust-v0.162.1', assetsOnly: true, githubToken: 'fixture-private-token',
    fetchImpl: async (url, init) => {
      requests.push(String(url));
      assert.equal(init.headers.authorization, undefined);
      // GitHub expanded_assets row structure observed 2026-10-18; formatting
      // and classes are irrelevant, href and clipboard digest are the facts.
      return new Response(`<ul>
        <li><a href="/openai/codex/releases/download/rust-v0.162.1/other.zip">other</a>
          <clipboard-copy value="sha256:${'a'.repeat(64)}"></clipboard-copy></li>
        <li><a href="/openai/codex/releases/download/rust-v0.162.1/codex-package-aarch64-unknown-linux-musl.tar.gz">Codex</a>
          <span>sha256:untrusted-display-copy</span>
          <clipboard-copy aria-label="Copy digest" value="sha256:${'b'.repeat(64)}"></clipboard-copy></li>
        <li><a href="https://elsewhere.invalid/codex.zip">wrong origin</a>
          <clipboard-copy value="sha256:${'c'.repeat(64)}"></clipboard-copy></li>
      </ul>`);
    },
  });
  assert.deepEqual(requests, ['https://github.com/openai/codex/releases/expanded_assets/rust-v0.162.1']);
  assert.deepEqual(release.assets.map(({ name, digest }) => ({ name, digest })), [
    { name: 'other.zip', digest: `sha256:${'a'.repeat(64)}` },
    { name: 'codex-package-aarch64-unknown-linux-musl.tar.gz', digest: `sha256:${'b'.repeat(64)}` },
  ]);
  assert.equal(release.assets[1].browser_download_url,
    'https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-package-aarch64-unknown-linux-musl.tar.gz');
});

test('pinned public metadata fails closed on missing rows or ambiguous asset integrity', async () => {
  const row = (digest) => `<li><a href="/acme/tool/releases/download/v1/tool.zip">tool</a><clipboard-copy value="sha256:${digest.repeat(64)}"></clipboard-copy></li>`;
  for (const html of ['<html>Sign in</html>', row('a') + row('b'),
    row('a').replace('</li>', `<clipboard-copy value="sha256:${'b'.repeat(64)}"></clipboard-copy></li>`)]) {
    await assert.rejects(fetchGitHubReleaseByTag({ githubRepo: 'acme/tool', tag: 'v1', assetsOnly: true,
      fetchImpl: async () => new Response(html),
    }), /metadata/);
  }
});
