import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNpmRegistryHttpsClient, NpmRegistryHttpError } from './httpsClient';
import { downloadResolvedNpmArtifact } from './download';
import { resolveAndDownloadNpmArtifact } from './adapter';

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
  afterEach(() => vi.useRealTimers());

  it.each(['metadata', 'signing keys', 'attestations'] as const)('acquires valid npm JSON beyond the former implicit %s ceiling', async (kind) => {
    const artifact = 'verified package';
    const integrity = `sha512-${createHash('sha512').update(artifact).digest('base64')}`;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = publicKey.export({ type: 'spki', format: 'der' });
    const keyid = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
    const signatures = kind === 'signing keys' ? [{ keyid, sig: sign('sha256', Buffer.from(`plugin@1.0.0:${integrity}`), privateKey).toString('base64') }] : [];
    const metadata = {
      name: 'plugin',
      ...(kind === 'metadata' ? { padding: 'x'.repeat(8 * 1024 * 1024) } : {}),
      versions: { '1.0.0': { name: 'plugin', version: '1.0.0', dist: {
        integrity, tarball: 'https://registry.example.test/plugin.tgz', signatures,
        ...(kind === 'attestations' ? { attestations: {
          url: 'https://registry.example.test/attestations', provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
        } } : {}),
      } } },
    };
    const responses = [response(JSON.stringify(metadata))];
    if (kind === 'signing keys') responses.push(response(JSON.stringify({
      padding: 'x'.repeat(1024 * 1024),
      keys: [{ keyid, key: key.toString('base64'), keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', expires: null }],
    })));
    responses.push(response(artifact, { headers: { 'content-type': 'application/octet-stream' } }));
    if (kind === 'attestations') responses.push(response(JSON.stringify({
      padding: 'x'.repeat(2 * 1024 * 1024),
      attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: {} }],
    })));
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-json-budget-'));
    try {
      const client = createNpmRegistryHttpsClient({
        registryOrigin: 'https://registry.example.test', lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: requestBoundary({ responses, seen: [] }),
      });
      const candidate = await resolveAndDownloadNpmArtifact({
        input: { registryOrigin: 'https://registry.example.test', packageName: 'plugin', selector: '1.0.0' },
        destinationPath: join(dir, 'candidate.tgz'), client,
      });
      expect(candidate.source.version).toBe('1.0.0');
      if (kind === 'signing keys') expect(candidate.registrySignature).toMatchObject({ status: 'verified' });
      if (kind === 'attestations') expect(candidate.provenance).toMatchObject({ status: 'retrieved', verified: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('follows finite registry redirects beyond the former ceiling and detects a real loop', async () => {
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test',
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({
        responses: [...Array.from({ length: 12 }, (_, hop) => response('', { statusCode: 302, headers: { location: `/${hop + 1}` } })), response('{"ok":true}')],
        seen: [],
      }),
    });
    await expect(client.getJson({ url: 'https://registry.example.test/0', maxBytes: 1000, headers: {} })).resolves.toEqual({ ok: true });
    const loopClient = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test', lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({ responses: Array.from({ length: 12 }, () => response('', { statusCode: 302, headers: { location: '/0' } })), seen: [] }),
    });
    await expect(loopClient.getJson({ url: 'https://registry.example.test/0', maxBytes: 1000, headers: {} })).rejects.toThrow(/redirect loop/);
  });

  it('detects a redirect loop when only the non-requested URL fragment changes', async () => {
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test', lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({ responses: [
        response('', { statusCode: 302, headers: { location: '/0#different' } }), response('{"ok":true}'),
      ], seen: [] }),
    });
    await expect(client.getJson({ url: 'https://registry.example.test/0', headers: {} })).rejects.toThrow(/redirect loop/);
  });

  it('accepts response headers already admitted by the containing native HTTP parser', async () => {
    // The native transport may have an operator-configured maxHeaderSize.
    // Its callback supplies an already parsed IncomingMessage, not raw header bytes.
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test', lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({ responses: [response('{"ok":true}', {
        headers: { 'content-type': 'application/json', 'x-registry-context': 'x'.repeat(64 * 1024 + 1) },
      })], seen: [] }),
    });
    await expect(client.getJson({ url: 'https://registry.example.test/plugin', headers: {} })).resolves.toEqual({ ok: true });
  });

  it('cancels acquisition of artifact headers through the real HTTPS client', async () => {
    let started!: () => void;
    const opening = new Promise<void>((resolve) => { started = resolve; });
    const boundary = ((_options: RequestOptions, _callback: (message: IncomingMessage) => void) => {
      const emitter = new EventEmitter() as EventEmitter & {
        end(): void;
        destroy(error?: Error): void;
      };
      emitter.end = started;
      emitter.destroy = (error) => { if (error) emitter.emit('error', error); };
      // HTTPS boundary never acknowledges headers; cancellation must destroy the request.
      return emitter as unknown as ClientRequest;
    }) as typeof import('node:https').request;
    const controller = new AbortController();
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test',
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: boundary,
    });
    const operation = downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test', packageName: 'plugin', version: '1.0.0',
        versionMetadata: {}, integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        tarballUrl: 'https://registry.example.test/plugin.tgz', signatures: [],
      },
      destinationPath: join(tmpdir(), 'unopened-plugin-cancellation-candidate.tgz'),
      maxBytes: 1000, client, signal: controller.signal,
    });
    const rejected = expect(operation).rejects.toThrow('artifact headers cancelled');
    await opening;
    controller.abort(new Error('artifact headers cancelled'));
    await rejected;
  });

  it('keeps a slow DNS request pending without an implicit operation deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let resolveDns!: (answers: readonly { address: string; family: 4 }[]) => void;
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test',
      lookup: () => new Promise((resolve) => { resolveDns = resolve; }),
      request: requestBoundary({ responses: [response('{"ok":true}')], seen: [] }),
    });
    const operation = client.getJson({ url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: {} });
    let settled = false;
    void operation.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(300_001);
    expect(settled).toBe(false);
    resolveDns([{ address: '93.184.216.34', family: 4 }]);
    await expect(operation).resolves.toEqual({ ok: true });
  });

  it('cancels DNS before requesting and cancels a streamed metadata body', async () => {
    const controller = new AbortController();
    const seen: RequestOptions[] = [];
    let resolveDns!: (answers: readonly { address: string; family: 4 }[]) => void;
    const client = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test', lookup: () => new Promise((resolve) => { resolveDns = resolve; }),
      request: requestBoundary({ responses: [], seen }),
    });
    const operation = client.getJson({ url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: {}, signal: controller.signal });
    const rejected = expect(operation).rejects.toThrow('install cancelled');
    controller.abort(new Error('install cancelled'));
    await rejected;
    resolveDns([{ address: '93.184.216.34', family: 4 }]);
    await Promise.resolve();
    expect(seen).toEqual([]);

    const bodyController = new AbortController();
    const body = new Readable({ read() {} });
    Object.assign(body, { statusCode: 200, headers: { 'content-type': 'application/json' } });
    const bodyClient = createNpmRegistryHttpsClient({
      registryOrigin: 'https://registry.example.test', lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestBoundary({ responses: [body as unknown as IncomingMessage], seen: [] }),
    });
    const reading = bodyClient.getJson({ url: 'https://registry.example.test/plugin', maxBytes: 1000, headers: {}, signal: bodyController.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bodyRejected = expect(reading).rejects.toThrow('body cancelled');
    bodyController.abort(new Error('body cancelled'));
    await bodyRejected;
    expect(body.destroyed).toBe(true);
  });

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
