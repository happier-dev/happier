import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';

describe('probeServerVersion', () => {
  let server: http.Server;
  let baseUrl: string;
  let responseMode: 'ok' | 'http_503' | 'invalid_json' = 'ok';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/v1/version') {
        if (responseMode === 'http_503') {
          res.statusCode = 503;
          res.setHeader('content-type', 'text/plain');
          res.end('service unavailable');
          return;
        }
        if (responseMode === 'invalid_json') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end('{invalid-json');
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: 'test' }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('expected a TCP address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('returns ok and parses version response', async () => {
    responseMode = 'ok';
    const { probeServerVersion } = await import('./serverTest');
    const out = await probeServerVersion(baseUrl);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(`expected ok result, got: ${out.error}`);
    expect(out.url).toBe(`${baseUrl}/v1/version`);
    expect(out.version).toBe('test');
  });

  it('bypasses a custom global agent when probing loopback endpoints', async () => {
    responseMode = 'ok';

    const previousAgent = (http as any).globalAgent;
    (http as any).globalAgent = {
      addRequest() {
        throw new Error('global_agent_used');
      },
    };

    try {
      const { probeServerVersion } = await import('./serverTest');
      const out = await probeServerVersion(baseUrl);
      expect(out.ok).toBe(true);
    } finally {
      (http as any).globalAgent = previousAgent;
    }
  });

  it('returns http status failure for non-200 /v1/version responses', async () => {
    responseMode = 'http_503';
    const { probeServerVersion } = await import('./serverTest');
    const out = await probeServerVersion(baseUrl);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected non-200 probe result');
    expect(out.url).toBe(`${baseUrl}/v1/version`);
    expect(out.status).toBe(503);
    expect(out.error).toBe('http_503');
  });

  it('returns parse error details for invalid JSON responses', async () => {
    responseMode = 'invalid_json';
    const { probeServerVersion } = await import('./serverTest');
    const out = await probeServerVersion(baseUrl);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected invalid-json probe result');
    expect(out.url).toBe(`${baseUrl}/v1/version`);
    expect(out.status).toBeNull();
    expect(out.error.length).toBeGreaterThan(0);
    expect(out.error.startsWith('http_')).toBe(false);
  });

  it('returns network failure details for unreachable endpoints', async () => {
    // Ensure this test stays well below Vitest's default 5s timeout. The production helper's
    // default timeout is also 5s, which can race with Vitest when a connect attempt hangs.
    const prevTimeout = process.env.HAPPIER_SERVER_TEST_TIMEOUT_MS;
    process.env.HAPPIER_SERVER_TEST_TIMEOUT_MS = '250';
    try {
      const unreachablePort = await new Promise<number>((resolve, reject) => {
        const ephemeralServer = http.createServer();
        ephemeralServer.listen(0, () => {
          const address = ephemeralServer.address();
          if (!address || typeof address === 'string') {
            reject(new Error('expected TCP address'));
            return;
          }
          ephemeralServer.close((error) => (error ? reject(error) : resolve(address.port)));
        });
      });

      const { probeServerVersion } = await import('./serverTest');
      const out = await probeServerVersion(`http://127.0.0.1:${unreachablePort}`);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected unreachable endpoint to fail');
      expect(out.url).toBe(`http://127.0.0.1:${unreachablePort}/v1/version`);
      expect(out.status).toBeNull();
      expect(out.error.length).toBeGreaterThan(0);
      expect(out.error.startsWith('http_')).toBe(false);
    } finally {
      process.env.HAPPIER_SERVER_TEST_TIMEOUT_MS = prevTimeout;
    }
  });
});
