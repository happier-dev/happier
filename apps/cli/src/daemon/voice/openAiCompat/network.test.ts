import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createPinnedProviderLookup, fetchPinnedProviderEndpoint } from './network';

function lookupOnce(
  lookup: ReturnType<typeof createPinnedProviderLookup>,
  hostname: string,
  family: 0 | 4 | 6 = 0,
): Promise<Readonly<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { family }, (error, address, resolvedFamily) => {
      if (error) {
        reject(error);
        return;
      }
      if (typeof address !== 'string') {
        reject(new Error('Expected one pinned address'));
        return;
      }
      resolve({ address, family: resolvedFamily ?? 0 });
    });
  });
}

describe('OpenAI-compatible pinned provider lookup', () => {
  it('returns only pre-assessed addresses and rejects a changed hostname', async () => {
    const lookup = createPinnedProviderLookup({
      hostname: 'gateway.example.test',
      resolvedAddresses: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    });
    await expect(lookupOnce(lookup, 'gateway.example.test', 4)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
    await expect(lookupOnce(lookup, 'gateway.example.test', 6)).resolves.toEqual({
      address: '2606:2800:220:1:248:1893:25c8:1946',
      family: 6,
    });
    await expect(lookupOnce(lookup, 'attacker.example.test')).rejects.toThrow(/host/i);
  });

  it('uses the pinned production dispatcher for a real bounded loopback request', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const origin = `http://localhost:${address.port}`;
      const request = await fetchPinnedProviderEndpoint({
        endpoint: {
          normalizedUrl: `${origin}/v1`,
          origin,
          hostname: 'localhost',
          protocol: 'http:',
          locality: 'loopback',
          scope: 'machine',
          resolvedAddresses: ['127.0.0.1'],
          nonPublicAddresses: ['127.0.0.1'],
        },
        url: `${origin}/v1/models`,
        init: { method: 'GET', redirect: 'manual' },
      });
      try {
        await expect(request.response.json()).resolves.toEqual({ ok: true });
      } finally {
        await request.dispose();
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
