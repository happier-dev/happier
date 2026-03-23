import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { requestBytes, requestJson, requestText } from '../dist/http.js';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected tcp server address');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function withServers(handlers, run) {
  const servers = [];
  const baseUrls = [];
  try {
    for (const handler of handlers) {
      const server = createServer(handler);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected tcp server address');
      }
      servers.push(server);
      baseUrls.push(`http://127.0.0.1:${address.port}`);
    }
    await run(baseUrls);
  } finally {
    await Promise.all(
      servers.map(
        (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      ),
    );
  }
}

test('requestJson works without global fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('global fetch should not be used');
  };
  try {
    await withServer((req, res) => {
      assert.equal(req.headers['user-agent'], 'test-agent');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value: 7 }));
    }, async (baseUrl) => {
      const result = await requestJson({
        url: `${baseUrl}/release`,
        headers: { 'user-agent': 'test-agent' },
      });
      assert.deepEqual(result, { ok: true, value: 7 });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestText supports redirects without global fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('global fetch should not be used');
  };
  try {
    await withServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }, async (baseUrl) => {
      const result = await requestText({ url: `${baseUrl}/redirect` });
      assert.equal(result, 'ok');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestText preserves Authorization on same-origin redirects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('global fetch should not be used');
  };
  try {
    await withServer((req, res) => {
      if (req.url === '/redirect') {
        assert.equal(req.headers.authorization, 'Bearer same-origin-token');
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      assert.equal(req.headers.authorization, 'Bearer same-origin-token');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }, async (baseUrl) => {
      const result = await requestText({
        url: `${baseUrl}/redirect`,
        headers: { authorization: 'Bearer same-origin-token' },
      });
      assert.equal(result, 'ok');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestText strips Authorization on cross-origin redirects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('global fetch should not be used');
  };
  try {
    let finalBaseUrl = '';
    await withServers([
      (redirectReq, redirectRes) => {
        assert.equal(redirectReq.headers.authorization, 'Bearer cross-origin-token');
        redirectRes.writeHead(302, { location: `${finalBaseUrl}/final` });
        redirectRes.end();
      },
      (finalReq, finalRes) => {
        assert.equal(finalReq.headers.authorization, undefined);
        finalRes.writeHead(200, { 'content-type': 'text/plain' });
        finalRes.end('ok');
      },
    ], async ([baseUrl, resolvedFinalBaseUrl]) => {
      finalBaseUrl = resolvedFinalBaseUrl;
      const result = await requestText({
        url: `${baseUrl}/redirect`,
        headers: { authorization: 'Bearer cross-origin-token' },
      });
      assert.equal(result, 'ok');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestBytes supports data urls without global fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('global fetch should not be used');
  };
  try {
    const result = await requestBytes({
      url: `data:text/plain;base64,${Buffer.from('hello world', 'utf8').toString('base64')}`,
    });
    assert.equal(result.toString('utf8'), 'hello world');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
