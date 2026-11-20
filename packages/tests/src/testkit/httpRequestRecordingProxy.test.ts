import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES, startHttpRequestRecordingProxy } from './httpRequestRecordingProxy';
import { withTimeoutMs } from './timing/withTimeout';
import { createEphemeralTlsServerFixture } from './tls/ephemeralTlsServerFixture.mjs';

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForNoSockets(sockets: ReadonlySet<Socket>, label: string): Promise<void> {
  await withTimeoutMs({
    promise: new Promise<void>((resolve) => {
      const check = () => {
        if (sockets.size === 0) {
          resolve();
          return;
        }
        setTimeout(check, 25);
      };
      check();
    }),
    timeoutMs: 1_000,
    label,
  });
}

describe('startHttpRequestRecordingProxy', () => {
  it('counts actual encoded HTTP bodies and upgraded bytes without retaining payloads', async () => {
    const body = gzipSync('synthetic transport body: 😀 '.repeat(128));
    const upgradedPayload = Buffer.from('synthetic upgraded response');
    const targetSockets = new Set<Socket>();
    const target = createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length });
      res.end(body);
    });
    target.on('connection', socket => {
      targetSockets.add(socket);
      socket.once('close', () => targetSockets.delete(socket));
    });
    target.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.on('data', () => socket.write(upgradedPayload));
    });
    await listen(target);
    const address = target.address();
    if (!address || typeof address !== 'object') throw new Error('target server did not bind');
    const proxy = await startHttpRequestRecordingProxy({ targetBaseUrl: `http://127.0.0.1:${address.port}` });
    let upgraded: Socket | undefined;
    try {
      const response = await fetch(`${proxy.baseUrl}/body`);
      expect(await response.text()).toBe('synthetic transport body: 😀 '.repeat(128));
      expect(proxy.entries()[0]).toMatchObject({
        responseBodyWireBytes: body.length, responseContentEncoding: 'gzip', responseBody: null,
      });
      const url = new URL(proxy.baseUrl);
      upgraded = connect(Number(url.port), url.hostname);
      await once(upgraded, 'connect');
      upgraded.write(`GET /stream HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      await once(upgraded, 'data');
      const before = proxy.entries()[1]!.upgradedResponseWireBytes;
      const received = once(upgraded, 'data');
      upgraded.write('next');
      await received;
      expect(proxy.entries()[1]!.upgradedResponseWireBytes - before).toBe(upgradedPayload.length);
    } finally {
      upgraded?.destroy();
      await proxy.stop();
      for (const socket of targetSockets) socket.destroy();
      await closeServer(target);
    }
  });

  it.each(['br', 'gzip'])('captures decoded %s response text while forwarding its encoded bytes', async (encoding) => {
    const payload = { message: 'Captured response: 😀 '.repeat(128) };
    const text = JSON.stringify(payload);
    const encoded = encoding === 'br' ? brotliCompressSync(text) : gzipSync(text);
    const target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding,
        'content-length': encoded.length });
      res.end(encoded);
    });
    await listen(target);
    const address = target.address();
    if (!address || typeof address !== 'object') throw new Error('target server did not bind');
    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${address.port}`, captureResponseBody: true,
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/v3/automations/query`, {
        headers: { 'accept-encoding': encoding },
      });
      expect(response.headers.get('content-encoding')).toBe(encoding);
      expect(await response.json()).toEqual(payload);
      const entry = proxy.entries()[0];
      expect(entry).toMatchObject({ responseBodyWireBytes: encoded.length, responseContentEncoding: encoding,
        responseBody: { complete: true, truncated: false } });
      expect(JSON.parse(entry!.responseBody!.text)).toEqual(payload);
    } finally {
      await proxy.stop();
      await closeServer(target);
    }
  });

  it('keeps the existing capture bound after decompression without truncating the forwarded response', async () => {
    const text = 'x'.repeat(RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES + 1);
    const encoded = gzipSync(text);
    const target = createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': encoded.length });
      res.end(encoded);
    });
    await listen(target);
    const address = target.address();
    if (!address || typeof address !== 'object') throw new Error('target server did not bind');
    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${address.port}`, captureResponseBody: true,
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/expanded`);
      expect((await response.text()) === text).toBe(true);
      expect(proxy.entries()[0]).toMatchObject({ responseBodyWireBytes: encoded.length,
        responseBody: { complete: false, truncated: true, text: '' }, error: expect.any(String) });
    } finally {
      await proxy.stop();
      await closeServer(target);
    }
  });

  it('can expose an HTTP target through HTTPS trusted by only the supplied fixture CA', async () => {
    const target = createServer((req, res) => {
      req.resume();
      req.once('end', () => res.end('secure ingress'));
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');
    const host = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
    if (!host) throw new Error('Guest Home TLS test requires a non-loopback IPv4 interface');
    const tls = await createEphemeralTlsServerFixture({ additionalIpAddresses: [host] });
    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
      listenHost: host,
      tls: {
        key: await readFile(tls.privateKeyPath),
        cert: await readFile(tls.leafCertificatePath),
      },
    });

    try {
      const ca = await readFile(tls.caCertificatePath);
      const payload = await new Promise<string>((resolve, reject) => {
        const request = httpsRequest(proxy.baseUrl, {
          ca,
          rejectUnauthorized: true,
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.once('error', reject);
        request.end();
      });
      expect(payload).toBe('secure ingress');
      expect(new URL(proxy.baseUrl).hostname).toBe(host);
    } finally {
      await proxy.stop().catch(() => {});
      await tls.cleanup();
      await closeServer(target);
    }
  });

  it('does not retain request bodies unless capture is explicitly enabled', async () => {
    const target = createServer((req, res) => {
      req.resume();
      req.once('end', () => res.end('ok'));
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');
    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    });

    try {
      await fetch(`${proxy.baseUrl}/private`, {
        method: 'POST',
        body: 'must-not-be-retained',
      });
      expect(proxy.entries()).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: '/private',
          body: null,
        }),
      ]);
    } finally {
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('retains upstream response bytes only when response capture is enabled, without breaking the forwarded body', async () => {
    const target = createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sealed: 'upstream-response-material' }));
      });
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');
    const targetBaseUrl = `http://127.0.0.1:${targetAddress.port}`;

    const silentProxy = await startHttpRequestRecordingProxy({ targetBaseUrl });
    const capturingProxy = await startHttpRequestRecordingProxy({
      targetBaseUrl,
      captureResponseBody: true,
    });
    try {
      const silent = await fetch(`${silentProxy.baseUrl}/v1/thing`);
      expect(await silent.text()).toContain('upstream-response-material');
      expect(silentProxy.entries()).toEqual([
        expect.objectContaining({ statusCode: 200, responseBody: null }),
      ]);

      const captured = await fetch(`${capturingProxy.baseUrl}/v1/thing`);
      expect(await captured.text()).toContain('upstream-response-material');
      expect(capturingProxy.entries()).toEqual([
        expect.objectContaining({
          statusCode: 200,
          responseBody: expect.objectContaining({
            text: JSON.stringify({ sealed: 'upstream-response-material' }),
            truncated: false,
          }),
        }),
      ]);
    } finally {
      await silentProxy.stop().catch(() => {});
      await capturingProxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it.each([undefined, 409])('forwards a rewritten response with status %s while recording the genuine upstream bytes', async (statusCode) => {
    const target = createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: req.url, origin: 'genuine' }));
      });
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');
    const eligible: string[] = [];
    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
      captureResponseBody: true,
      rewriteResponseBody: {
        ...(statusCode === undefined ? {} : { statusCode }),
        when: (request) => {
          eligible.push(request.path);
          return request.path === '/forged';
        },
        rewrite: (_request, upstreamBody) =>
          JSON.stringify({ ...JSON.parse(upstreamBody), origin: 'forged' }),
      },
    });

    try {
      const forged = await fetch(`${proxy.baseUrl}/forged`);
      expect(forged.status).toBe(statusCode ?? 200);
      expect(await forged.json()).toEqual({ path: '/forged', origin: 'forged' });
      const passthrough = await fetch(`${proxy.baseUrl}/untouched`);
      expect(passthrough.status).toBe(200);
      expect(await passthrough.json()).toEqual({ path: '/untouched', origin: 'genuine' });

      // Eligibility is decided from the request, before anything is forwarded, so an
      // ineligible request is never buffered.
      expect(eligible).toEqual(['/forged', '/untouched']);
      const recorded = proxy.entries();
      expect(recorded[0]?.statusCode).toBe(200);
      expect(recorded.map((entry) => entry.path)).toEqual(['/forged', '/untouched']);
      expect(JSON.parse(recorded[0]!.responseBody!.text)).toEqual({ path: '/forged', origin: 'genuine' });
      expect(JSON.parse(recorded[1]!.responseBody!.text)).toEqual({ path: '/untouched', origin: 'genuine' });
    } finally {
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('fails an eligible response closed instead of buffering past the rewrite cap', async () => {
    const target = createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.alloc(4_096, 0x61));
      });
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');
    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
      rewriteResponseBody: {
        when: (request) => request.path === '/oversized',
        rewrite: () => 'never forwarded',
        maxBufferedBytes: 512,
      },
    });

    try {
      const oversized = await fetch(`${proxy.baseUrl}/oversized`);
      expect(oversized.status).toBe(502);
      expect(await oversized.text()).toContain('buffer exceeded');

      // A request the rewrite does not select is unaffected by the cap.
      const streamed = await fetch(`${proxy.baseUrl}/streamed`);
      expect(streamed.status).toBe(200);
      expect((await streamed.arrayBuffer()).byteLength).toBe(4_096);

      expect(proxy.entries().map((entry) => ({ path: entry.path, statusCode: entry.statusCode }))).toEqual([
        { path: '/oversized', statusCode: 502 },
        { path: '/streamed', statusCode: 200 },
      ]);
      expect(proxy.entries()[0]!.error).toContain('512');
    } finally {
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('can withhold a committed upstream response until the caller releases it', async () => {
    let upstreamCommitCount = 0;
    let upstreamBody = '';
    const target = createServer((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        upstreamBody += chunk;
      });
      req.once('end', () => {
        upstreamCommitCount += 1;
        res.statusCode = 200;
        res.end('committed');
      });
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    let releaseResponse = (): void => {};
    const responseRelease = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let observeCommittedResponse = (): void => {};
    const committedResponseObserved = new Promise<void>((resolve) => {
      observeCommittedResponse = resolve;
    });
    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
      delayRequestMs: () => 25,
      captureRequestBody: (request) =>
        request.method === 'POST' && request.path === '/commit',
      beforeForwardResponse: async (request) => {
        expect(request).toMatchObject({
          method: 'POST',
          path: '/commit',
          statusCode: 200,
          body: {
            text: 'payload',
            byteLength: 7,
            truncated: false,
            complete: true,
          },
        });
        observeCommittedResponse();
        await responseRelease;
      },
    });
    let fetchSettled = false;
    const responsePromise = fetch(`${proxy.baseUrl}/commit`, {
      method: 'POST',
      body: 'payload',
    }).then(async (response) => {
      fetchSettled = true;
      return {
        status: response.status,
        body: await response.text(),
      };
    });

    try {
      await withTimeoutMs({
        promise: committedResponseObserved,
        timeoutMs: 1_000,
        label: 'committed upstream response to reach proxy latch',
      });
      expect(upstreamCommitCount).toBe(1);
      expect(upstreamBody).toBe('payload');
      expect(fetchSettled).toBe(false);

      releaseResponse();
      await expect(withTimeoutMs({
        promise: responsePromise,
        timeoutMs: 1_000,
        label: 'released proxy response',
      })).resolves.toEqual({
        status: 200,
        body: 'committed',
      });
    } finally {
      releaseResponse();
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('logs the route without the query when a response hook fails', async () => {
    const target = createServer((_req, res) => { res.end('upstream response'); });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
      beforeForwardResponse: () => { throw new Error('fixture rejected response'); },
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fetch(`${proxy.baseUrl}/callback?sample=1`);
      expect(response.status).toBe(502);
      await response.text();
      expect(errorLog).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        path: '/callback', message: 'fixture rejected response',
      }));
    } finally {
      errorLog.mockRestore();
      await proxy.stop();
      await closeServer(target);
    }
  });

  it('closes upgraded upstream sockets when stopped', async () => {
    const targetSockets = new Set<Socket>();
    const target = createServer((_req, res) => {
      res.end('ok');
    });
    target.on('connection', (socket) => {
      targetSockets.add(socket);
      socket.once('close', () => targetSockets.delete(socket));
    });
    target.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.resume();
      const ping = setInterval(() => {
        if (!socket.destroyed) socket.write('ping');
      }, 25);
      socket.once('close', () => clearInterval(ping));
      socket.once('error', () => clearInterval(ping));
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    });
    const proxyUrl = new URL(proxy.baseUrl);
    const socket = connect(Number(proxyUrl.port), proxyUrl.hostname);
    let stopPromise: Promise<void> | null = null;

    try {
      await once(socket, 'connect');
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: ${proxyUrl.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'));
      await once(socket, 'data');
      expect(targetSockets.size).toBeGreaterThan(0);

      stopPromise = proxy.stop();
      await expect(withTimeoutMs({
        promise: stopPromise,
        timeoutMs: 1_000,
        label: 'http request recording proxy stop',
      })).resolves.toBeUndefined();
      await expect(waitForNoSockets(targetSockets, 'http request recording upstream sockets to close')).resolves.toBeUndefined();
    } finally {
      socket.destroy();
      for (const targetSocket of targetSockets) targetSocket.destroy();
      await stopPromise?.catch(() => {});
      await closeServer(target);
    }
  });
});
