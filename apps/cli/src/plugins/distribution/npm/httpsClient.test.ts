import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createNpmRegistryHttpsClient, NpmRegistryHttpError } from './httpsClient';

function response(body: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const stream = Readable.from([body]);
  Object.assign(stream, { statusCode: 200, headers: { 'content-type': 'application/json' }, ...overrides });
  // System-boundary fixture: a readable with the IncomingMessage fields consumed by this adapter.
  return stream as unknown as IncomingMessage;
}

function requestBoundary(params: Readonly<{
  responses: IncomingMessage[];
  seen: RequestOptions[];
}>): typeof import('node:https').request {
  const implementation = ((options: RequestOptions, callback: (message: IncomingMessage) => void) => {
    params.seen.push(options);
    const emitter = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      end: () => void;
      destroy: (error?: Error) => void;
    };
    emitter.setTimeout = () => undefined;
    emitter.destroy = (error?: Error) => { if (error) emitter.emit('error', error); };
    emitter.end = () => queueMicrotask(() => callback(params.responses.shift()!));
    // System-boundary fixture: only ClientRequest methods exercised by the adapter are implemented.
    return emitter as unknown as ClientRequest;
  });
  return implementation as typeof import('node:https').request;
}

describe('createNpmRegistryHttpsClient', () => {
  it('classifies authentication failures without retaining response challenges or credentials', async () => {
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test',
      authorizationHeader: 'Bearer boundary-secret',
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({
        responses: [response('', {
          statusCode: 401,
          headers: { 'www-authenticate': 'Bearer error="boundary-secret"' },
        })],
        seen: [],
      }),
    });

    const error = await client.getJson({
      url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: { accept: 'application/json' },
      deadlineAtMonotonicMs: performance.now() + 1000,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(NpmRegistryHttpError);
    expect(error).toMatchObject({ code: 'authentication_failed', statusCode: 401 });
    expect(JSON.stringify(error)).not.toContain('boundary-secret');
  });

  it('pins a validated DNS answer and applies authentication only to the selected registry origin', async () => {
    const seen: RequestOptions[] = [];
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test',
      authorizationHeader: 'Bearer boundary-secret',
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({ responses: [response('{"ok":true}')], seen }),
    });

    await expect(client.getJson({
      url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: { accept: 'application/json' },
    })).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers).toMatchObject({ accept: 'application/json', authorization: 'Bearer boundary-secret' });
    const pinnedLookup = seen[0]?.lookup;
    expect(pinnedLookup).toBeTypeOf('function');
  });

  it('omits TLS SNI for IPv4 and bracketed IPv6 registry literals while retaining DNS hostnames', async () => {
    const cases = [
      {
        origin: 'https://127.0.0.1:4873',
        lookupAddress: '127.0.0.1',
        family: 4 as const,
        expectedHostname: '127.0.0.1',
        expectedServername: undefined,
      },
      {
        origin: 'https://[::1]:4873',
        lookupAddress: '::1',
        family: 6 as const,
        expectedHostname: '::1',
        expectedServername: undefined,
      },
      {
        origin: 'https://registry.example.test',
        lookupAddress: '93.184.216.34',
        family: 4 as const,
        expectedHostname: 'registry.example.test',
        expectedServername: 'registry.example.test',
      },
    ];

    for (const testCase of cases) {
      const seen: RequestOptions[] = [];
      const seenLookupHostnames: string[] = [];
      const client = createNpmRegistryHttpsClient({
        registryOrigin: testCase.origin,
        allowPrivateNetwork: true,
        lookup: async (hostname) => {
          seenLookupHostnames.push(hostname);
          return [{ address: testCase.lookupAddress, family: testCase.family }];
        },
        request: requestBoundary({ responses: [response('{"ok":true}')], seen }),
      });

      await expect(client.getJson({
        url: `${testCase.origin}/-/ping`,
        maxBytes: 1000,
        headers: { accept: 'application/json' },
      })).resolves.toEqual({ ok: true });
      expect(seenLookupHostnames).toEqual([testCase.expectedHostname]);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.hostname).toBe(testCase.expectedHostname);
      expect(seen[0]?.servername).toBe(testCase.expectedServername);
    }
  });

  it('allows private DNS only when the selected registry profile explicitly permits it', async () => {
    const request = requestBoundary({ responses: [response('{"ok":true}')], seen: [] });
    const denied = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.internal.test',
      lookup: async () => [{ address: '10.0.0.12', family: 4 }],
      request,
    });
    await expect(denied.getJson({
      url: 'https://registry.internal.test/ping', maxBytes: 1000, headers: { accept: 'application/json' },
    })).rejects.toThrow(/private|local|reserved/i);

    const allowed = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.internal.test',
      allowPrivateNetwork: true,
      lookup: async () => [{ address: '10.0.0.12', family: 4 }],
      request: requestBoundary({ responses: [response('{"ok":true}')], seen: [] }),
    });
    await expect(allowed.getJson({
      url: 'https://registry.internal.test/ping', maxBytes: 1000, headers: { accept: 'application/json' },
    })).resolves.toEqual({ ok: true });
  });

  it('rejects a redirect that attempts to leave the selected registry origin', async () => {
    const seen: RequestOptions[] = [];
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test',
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({
        responses: [response('', { statusCode: 302, headers: { location: 'https://evil.example.test/plugin' } })],
        seen,
      }),
    });

    await expect(client.getJson({
      url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: { accept: 'application/json' },
    })).rejects.toThrow(/redirect changed origin/i);
    expect(seen).toHaveLength(1);
  });

  it('fails closed when metadata omits a JSON content type', async () => {
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test',
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({ responses: [response('{}', { headers: {} })], seen: [] }),
    });
    await expect(client.getJson({
      url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: { accept: 'application/json' },
    })).rejects.toThrow(/not JSON/i);
  });

  it('applies an absolute deadline to DNS and streamed bodies, not only socket inactivity', async () => {
    const never = new Promise<readonly { address: string; family: 4 | 6 }[]>(() => undefined);
    const dnsClient = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test', timeoutMs: 10, lookup: async () => never,
      request: requestBoundary({ responses: [], seen: [] }),
    });
    await expect(dnsClient.getJson({
      url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: { accept: 'application/json' },
    })).rejects.toThrow(/timed out/i);

    const trickle = Readable.from((async function* () {
      yield '{';
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield '}';
    })());
    Object.assign(trickle, { statusCode: 200, headers: { 'content-type': 'application/json' } });
    const bodyClient = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test', timeoutMs: 10,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({ responses: [trickle as unknown as IncomingMessage], seen: [] }),
    });
    await expect(bodyClient.getJson({
      url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: { accept: 'application/json' },
    })).rejects.toThrow(/timed out/i);
  });
});
