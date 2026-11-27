import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createEphemeralTlsServerFixture } from '../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

import { openPinnedHttpStream } from './pinnedHttp';

const servers: (ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>)[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

async function listen(server: (ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>)): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('Expected a TCP test listener');
  return address.port;
}

function httpsRequestBoundary(seen: RequestOptions[]): typeof import('node:https').request {
  const implementation = ((options: RequestOptions, callback: (message: IncomingMessage) => void) => {
    seen.push(options);
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void;
      end: () => void;
    };
    request.destroy = (error?: Error) => {
      if (error) request.emit('error', error);
    };
    request.end = () => {
      const body = Readable.from(['ok']);
      Object.assign(body, { statusCode: 200, headers: {} });
      queueMicrotask(() => callback(body as unknown as IncomingMessage));
    };
    // System-boundary fixture: only ClientRequest methods exercised by the transport are implemented.
    return request as unknown as ClientRequest;
  });
  return implementation as typeof import('node:https').request;
}

describe('pinned HTTP stream transport', () => {
  it.each(['DELETE', 'OPTIONS', 'POST'])('frames a complete %s body by its byte length', async (method) => {
    let receivedBody = Buffer.alloc(0);
    let receivedLength: string | undefined;
    const server = createServer(async (request, response) => {
      receivedLength = request.headers['content-length'];
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      receivedBody = Buffer.concat(chunks);
      response.end('ok');
    });
    const port = await listen(server);
    const body = new TextEncoder().encode(JSON.stringify({ names: ['éclair'] }));
    const stream = await openPinnedHttpStream({
      url: `http://body.example.test:${port}/members`,
      validatedAddresses: ['127.0.0.1'],
      headers: { 'content-type': 'application/json' },
      method,
      body,
      signal: new AbortController().signal,
    });
    while (await stream.read() !== null) { /* Drain the real response. */ }
    expect(stream.status).toBe(200);
    expect(receivedBody).toEqual(Buffer.from(body));
    expect(receivedLength).toBe(String(body.byteLength));
  });

  it('omits TLS SNI for IPv4 and bracketed IPv6 URL literals while retaining DNS hostnames', async () => {
    const cases = [
      {
        url: 'https://127.0.0.1:4873/model.bin',
        validatedAddress: '127.0.0.1',
        expectedHostname: '127.0.0.1',
        expectedServername: undefined,
      },
      {
        url: 'https://[::1]:4873/model.bin',
        validatedAddress: '::1',
        expectedHostname: '::1',
        expectedServername: undefined,
      },
      {
        url: 'https://models.example.test/model.bin',
        validatedAddress: '93.184.216.34',
        expectedHostname: 'models.example.test',
        expectedServername: 'models.example.test',
      },
    ];

    for (const testCase of cases) {
      const seen: RequestOptions[] = [];
      const stream = await openPinnedHttpStream({
        url: testCase.url,
        validatedAddresses: [testCase.validatedAddress],
        headers: {},
        signal: new AbortController().signal,
        wallTimeMs: 1_000,
        idleTimeMs: 1_000,
      }, {
        httpsRequest: httpsRequestBoundary(seen),
      });
      await stream.cancel();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.hostname).toBe(testCase.expectedHostname);
      expect(seen[0]?.servername).toBe(testCase.expectedServername);
    }
  });

  it('verifies the expected TLS certificate before sending authenticated HTTP', async () => {
    const fixture = await createEphemeralTlsServerFixture();
    const defaultCAs = getCACertificates('default');
    const cert = await readFile(fixture.leafCertificatePath);
    const pin = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
    const requests: (string | undefined)[] = [];
    const server = createHttpsServer({ cert, key: await readFile(fixture.privateKeyPath) }, (request, response) => {
      requests.push(request.headers.authorization);
      response.end('ok');
    });
    const port = await listen(server);
    try {
      setDefaultCACertificates([...defaultCAs, await readFile(fixture.caCertificatePath, 'utf8')]);
      const input = {
        url: `https://localhost:${port}/models`,
        validatedAddresses: ['127.0.0.1'], headers: { authorization: 'Bearer test-token' },
        signal: new AbortController().signal,
      };
      const stream = await openPinnedHttpStream({ ...input, tlsCertificateSha256: pin });
      while (await stream.read() !== null) { /* Drain the real response. */ }
      await expect(openPinnedHttpStream({ ...input, tlsCertificateSha256: '0'.repeat(64) })).rejects.toThrow();
      expect(requests).toEqual(['Bearer test-token']);
    } finally {
      setDefaultCACertificates(defaultCAs);
      await fixture.cleanup();
    }
  });

  it('connects only through the caller-validated address while preserving the URL hostname', async () => {
    let receivedHost = '';
    const server = createServer((request, response) => {
      receivedHost = request.headers.host ?? '';
      response.end('ok');
    });
    const port = await listen(server);
    const stream = await openPinnedHttpStream({
      url: `http://localhost:${port}/model.bin`,
      validatedAddresses: ['127.0.0.1'],
      headers: { Host: 'attacker.invalid' },
      signal: new AbortController().signal,
      wallTimeMs: 1_000,
      idleTimeMs: 1_000,
    });
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await stream.read();
      if (chunk === null) break;
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')).toBe('ok');
    expect(receivedHost).toMatch(/^localhost:/);
  });

  it('does not reuse a pooled socket admitted for an older address set', async () => {
    const receivedAddresses: string[] = [];
    const server = createServer((request, response) => {
      receivedAddresses.push(request.socket.localAddress ?? '');
      response.end('ok');
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new TypeError('Expected a TCP test listener');

    for (const validatedAddress of ['127.0.0.1', '::1']) {
      const stream = await openPinnedHttpStream({
        url: `http://moving.internal.test:${address.port}/resource`,
        validatedAddresses: [validatedAddress],
        headers: {},
        signal: new AbortController().signal,
        wallTimeMs: 1_000,
        idleTimeMs: 1_000,
      });
      while (await stream.read() !== null) {
        // Drain the response so the global agent may pool the socket.
      }
    }

    expect(receivedAddresses).toEqual(['::ffff:127.0.0.1', '::1']);
  });

  it('rejects a body read after the response stays idle beyond the caller budget', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.flushHeaders();
    });
    const port = await listen(server);
    const stream = await openPinnedHttpStream({
      url: `http://localhost:${port}/model.bin`,
      validatedAddresses: ['127.0.0.1'],
      headers: {},
      signal: new AbortController().signal,
      wallTimeMs: 1_000,
      idleTimeMs: 20,
    });
    await expect(stream.read()).rejects.toThrow('pinned_http_idle_timeout');
  });

  it('rejects before headers when the request exceeds the wall-time budget', async () => {
    const server = createServer(() => {
      // Intentionally never send response headers.
    });
    const port = await listen(server);
    await expect(openPinnedHttpStream({
      url: `http://localhost:${port}/model.bin`,
      validatedAddresses: ['127.0.0.1'],
      headers: {},
      signal: new AbortController().signal,
      wallTimeMs: 20,
      idleTimeMs: 1_000,
    })).rejects.toThrow('pinned_http_wall_timeout');
  });
});
