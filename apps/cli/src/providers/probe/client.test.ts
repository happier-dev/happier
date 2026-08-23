import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol';

import {
  PROVIDER_MODEL_LOAD_HTTP_LIMITS,
  ProviderProbeCancelledError,
  ProviderProbeClientError,
  createProviderProbeHttpClient,
  type ProviderProbeTransport,
} from './client';

const authorizedDestination = { authorizeDestination: async () => {} } as const;

function response(input: Partial<Awaited<ReturnType<ProviderProbeTransport>>> = {}) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"data":[{"id":"model-a"}]}'),
    ...input,
  };
}

function credentialResolver(
  credential: Readonly<{
    kind: 'httpHeader';
    name: string;
    value: string;
  }>,
) {
  return async () => ({ credential, close: () => {} });
}

describe('provider probe HTTP client', () => {
  it('parses a Provider-contributed catalog format and reports an unimplemented one typed', async () => {
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => response({
        body: Buffer.from('{"entries":[{"slug":"acme/one","label":"Acme One"}]}'),
      }),
    });
    const request = {
      endpointUrl: 'https://models.example/v1',
      path: '/v1/catalog',
      parser: 'acme-catalog-v3',
      publicHeaders: {},
      ...authorizedDestination,
    } as const;

    const result = await client.getCatalog({
      ...request,
      contributedCatalogParsers: {
        'acme-catalog-v3': (body) => ({
          models: (body as { entries: readonly { slug: string; label: string }[] })
            .entries.map((entry) => ({ id: entry.slug, name: entry.label })),
        }),
      },
    });
    expect(result.catalog).toEqual({
      models: [{ id: 'acme/one', name: 'Acme One' }],
      loadStates: [],
    });

    // Without the contributing plugin the declared format has no reachable
    // implementation: it must report a typed unavailable rather than reading
    // the body with another Provider's parser.
    await expect(client.getCatalog(request)).rejects.toMatchObject({
      code: 'provider_contribution_unavailable',
    });
  });

  it('materializes and closes credentials only after fresh DNS and destination authorization', async () => {
    const events: string[] = [];
    const close = vi.fn();
    const resolveCredential = vi.fn(async () => {
      events.push('credential');
      return {
        credential: { kind: 'httpHeader' as const, name: 'authorization', value: 'Bearer secret' },
        close,
      };
    });
    const transport = vi.fn<ProviderProbeTransport>(async (request) => {
      events.push('transport');
      expect(request.headers.authorization).toBe('Bearer secret');
      return response();
    });
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => {
        events.push('dns');
        return ['93.184.216.34'];
      },
      transport,
    });

    await client.getCatalog({
      endpointUrl: 'https://models.example/v1',
      path: '/v1/models',
      parser: 'openai-models',
      publicHeaders: {},
      authorizeDestination: async () => { events.push('authorize'); },
      resolveCredential,
    });
    expect(events).toEqual(['dns', 'authorize', 'credential', 'transport']);
    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    events.length = 0;
    resolveCredential.mockClear();
    close.mockClear();
    transport.mockClear();
    const unsafeClient = createProviderProbeHttpClient({
      resolveAddresses: async () => ['64:ff9b:1:a9fe:a9:fe00::'],
      transport,
    });
    await expect(unsafeClient.getCatalog({
      endpointUrl: 'https://models.example/v1',
      path: '/v1/models',
      parser: 'openai-models',
      publicHeaders: {},
      authorizeDestination: async () => { events.push('authorize'); },
      resolveCredential,
    })).rejects.toMatchObject({ code: 'provider_endpoint_unreachable' });
    expect(events).toEqual([]);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('validates every DNS answer and pins the validated set into transport', async () => {
    const transport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response());
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34', '169.254.169.254'],
      transport,
    });
    await expect(client.getCatalog({
      endpointUrl: 'https://models.example/v1',
      path: '/v1/models',
      parser: 'openai-models',
      publicHeaders: {} as Readonly<Record<string, string>>,
      ...authorizedDestination,
    })).rejects.toMatchObject({ code: 'provider_endpoint_unreachable' });
    expect(transport).not.toHaveBeenCalled();

    const safeTransport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response());
    const safeClient = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.35', '93.184.216.34'],
      transport: safeTransport,
    });
    await safeClient.getCatalog({
      endpointUrl: 'https://models.example/v1',
      path: '/v1/models',
      parser: 'openai-models',
      publicHeaders: {},
      ...authorizedDestination,
    });
    expect(safeTransport).toHaveBeenCalledWith(expect.objectContaining({
      hostname: 'models.example',
      validatedAddresses: ['93.184.216.34', '93.184.216.35'],
      servername: 'models.example',
    }));
  });

  it('re-authorizes redirects and strips credentials and endpoint-owned headers across origins', async () => {
    const transport = vi.fn<ProviderProbeTransport>()
      .mockResolvedValueOnce(response({ status: 302, headers: { location: 'https://other.example/models' }, body: Buffer.alloc(0) }))
      .mockResolvedValueOnce(response());
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport,
    });
    await client.getCatalog({
      endpointUrl: 'https://models.example/v1',
      path: '/v1/models',
      parser: 'openai-models',
      publicHeaders: { 'x-client': 'happier' },
      ...authorizedDestination,
      resolveCredential: credentialResolver({ kind: 'httpHeader', name: 'authorization', value: 'Bearer secret' }),
    });
    expect(transport.mock.calls[0]![0].headers.authorization).toBe('Bearer secret');
    expect(transport.mock.calls[1]![0].headers.authorization).toBeUndefined();
    expect(transport.mock.calls[1]![0].headers['x-client']).toBeUndefined();
  });

  it.each([
    {
      name: 'raw credential in a cross-origin path',
      location: 'https://attacker.example/leak/provider-secret-42',
      credential: { kind: 'httpHeader' as const, name: 'authorization', value: 'provider-secret-42' },
      publicHeaders: {} as Readonly<Record<string, string>>,
    },
    {
      name: 'percent-encoded public header in a same-origin query',
      location: '/next?route=tenant%2Fsensitive%3Fvalue',
      credential: undefined,
      publicHeaders: { 'x-tenant': 'tenant/sensitive?value' },
    },
    {
      name: 'form-encoded public header in a same-origin query',
      location: '/next?route=tenant+sensitive+value',
      credential: undefined,
      publicHeaders: { 'x-tenant': 'tenant sensitive value' },
    },
  ])('rejects a redirect target containing $name before a second dispatch', async ({
    location,
    credential,
    publicHeaders,
  }) => {
    const transport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response({
      status: 302,
      headers: { location },
      body: Buffer.alloc(0),
    }));
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport,
    });

    await expect(client.getCatalog({
      endpointUrl: 'https://models.example/v1',
      path: '/v1/models',
      parser: 'openai-models',
      publicHeaders,
      ...(credential ? { resolveCredential: credentialResolver(credential) } : {}),
      ...authorizedDestination,
    })).rejects.toMatchObject({ code: 'provider_probe_response_invalid' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('maps a malformed redirect location to the stable invalid-response error', async () => {
    const transport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response({
      status: 302,
      headers: { location: 'https://[invalid-host' },
      body: Buffer.alloc(0),
    }));
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport,
    });

    await expect(client.getCatalog({
      endpointUrl: 'https://models.example',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
      ...authorizedDestination,
    })).rejects.toMatchObject({ code: 'provider_probe_response_invalid' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to an unconditional metadata hostname before a second dispatch', async () => {
    const transport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response({
      status: 302,
      headers: { location: 'https://metadata.google.internal/computeMetadata/v1' },
      body: Buffer.alloc(0),
    }));
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport,
    });

    await expect(client.getCatalog({
      endpointUrl: 'https://models.example',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
      resolveCredential: credentialResolver({ kind: 'httpHeader', name: 'authorization', value: 'Bearer secret' }),
      ...authorizedDestination,
    })).rejects.toMatchObject({ code: 'provider_endpoint_unreachable' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('preserves caller cancellation instead of classifying it as endpoint failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn<ProviderProbeTransport>();
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport,
    });

    await expect(client.getCatalog({
      endpointUrl: 'https://models.example',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
      signal: controller.signal,
      ...authorizedDestination,
    })).rejects.toBeInstanceOf(ProviderProbeCancelledError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('discards a response when cancellation wins after dispatch', async () => {
    const controller = new AbortController();
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => {
        controller.abort();
        return response();
      },
    });

    await expect(client.getCatalog({
      endpointUrl: 'https://models.example',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
      signal: controller.signal,
      ...authorizedDestination,
    })).rejects.toBeInstanceOf(ProviderProbeCancelledError);
  });

  it('refuses a freshly resolved destination before transport when canonical authorization rejects it', async () => {
    const transport = vi.fn<ProviderProbeTransport>();
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['10.0.0.12'],
      transport,
    });
    await expect(client.getCatalog({
      endpointUrl: 'http://gateway.lan',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
      authorizeDestination: async () => { throw new Error('destination denied'); },
    })).rejects.toThrow('destination denied');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [401, false, 'provider_endpoint_auth_required'],
    [401, true, 'provider_endpoint_unauthorized'],
    [403, true, 'provider_endpoint_unauthorized'],
    [429, false, 'provider_endpoint_rate_limited'],
    [503, false, 'provider_endpoint_unavailable'],
  ] as const)('maps HTTP %s with credential=%s to %s', async (status, withCredential, code) => {
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => response({ status, headers: status === 429 ? { 'retry-after': '2' } : {} }),
    });
    await expect(client.getCatalog({
      endpointUrl: 'https://models.example',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
      ...authorizedDestination,
      ...(withCredential ? {
        resolveCredential: credentialResolver({ kind: 'httpHeader', name: 'authorization', value: 'secret' }),
      } : {}),
    })).rejects.toMatchObject({ code, ...(status === 429 ? { retryAfterMs: 2_000 } : {}) });
  });

  it.each([401, 403] as const)('retains authenticated catalog HTTP %s without retaining secret response material', async (status) => {
    const secret = 'Bearer selected-account-secret';
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => response({
        status,
        headers: { 'x-secret-detail': secret },
        body: Buffer.from(secret),
      }),
    });

    let observed: unknown;
    try {
      await client.getCatalog({
        endpointUrl: 'https://models.example',
        path: '/models',
        parser: 'openai-models',
        publicHeaders: {},
        ...authorizedDestination,
        resolveCredential: credentialResolver({
          kind: 'httpHeader',
          name: 'authorization',
          value: secret,
        }),
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({
      code: 'provider_endpoint_unauthorized',
      httpStatus: status,
    });
    expect(JSON.stringify(observed)).not.toContain(secret);
  });

  it('treats auth status from a no-credential endpoint as an invalid provider contract', async () => {
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => response({ status: 401 }),
    });
    await expect(client.getCatalog({
      endpointUrl: 'https://models.example',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
      ...authorizedDestination,
      credentialPolicy: 'none',
    })).rejects.toMatchObject({ code: 'provider_probe_response_invalid' });
  });

  it('decodes supported compression before JSON and rejects decoded over-limit bodies', async () => {
    const compressed = gzipSync(Buffer.from('{"data":[{"id":"model-a"}]}'));
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => response({
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: compressed,
      }),
    });
    await expect(client.getCatalog({
      endpointUrl: 'https://models.example', path: '/models', parser: 'openai-models', publicHeaders: {}, ...authorizedDestination,
    })).resolves.toMatchObject({ catalog: { models: [{ id: 'model-a' }] } });

    const oversizedClient = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => response({ body: Buffer.alloc(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxDecodedBodyBytes + 1) }),
    });
    await expect(oversizedClient.getCatalog({
      endpointUrl: 'https://models.example', path: '/models', parser: 'openai-models', publicHeaders: {}, ...authorizedDestination,
    })).rejects.toBeInstanceOf(ProviderProbeClientError);
  });

  it('spends one wall budget across the whole redirect chain', async () => {
    const wallTimeouts: number[] = [];
    let clock = 0;
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      now: () => clock,
      transport: async (request) => {
        wallTimeouts.push(request.wallTimeMs);
        clock += 12_000;
        return wallTimeouts.length === 1
          ? {
              status: 302,
              headers: { location: 'https://models.example/v2/models' },
              body: Buffer.alloc(0),
            }
          : response();
      },
    });

    await expect(client.getCatalog({
      endpointUrl: 'https://models.example', path: '/models', parser: 'openai-models', publicHeaders: {}, ...authorizedDestination,
    })).resolves.toMatchObject({ catalog: { models: [{ id: 'model-a' }] } });

    expect(wallTimeouts).toEqual([
      PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
      PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs - 12_000,
    ]);
  });

  it('bounds a managed authenticated response that returns headers and never finishes its body', async () => {
    vi.useFakeTimers();
    try {
      let bodyCancelled = false;
      const stalledBody = new ReadableStream<Uint8Array>({
        start() {
          // Headers are already delivered; the body never produces a chunk.
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      const client = createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport: async () => {
          throw new Error('the managed branch must not reach the pinned transport');
        },
      });

      const settled = client.getCatalog({
        endpointUrl: 'http://127.0.0.1:4096',
        path: '/models',
        parser: 'openai-models',
        publicHeaders: {},
        credentialPolicy: 'required',
        managedRequest: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: stalledBody,
        }),
        ...authorizedDestination,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(
        PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs + 1_000,
      );

      const error = await settled;
      expect(error).toBeInstanceOf(ProviderProbeClientError);
      expect(error).toMatchObject({ code: 'provider_endpoint_unreachable' });
      expect(bodyCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps transport errors without retaining raw secret-bearing messages', async () => {
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => { throw new Error('socket failed Authorization: Bearer secret-value'); },
    });
    const error = await client.getCatalog({
      endpointUrl: 'https://models.example', path: '/models', parser: 'openai-models', publicHeaders: {}, ...authorizedDestination,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'provider_endpoint_unreachable' });
    expect(String(error)).not.toContain('secret-value');
  });

  it('rejects catalog fields that echo the exact request credential', async () => {
    const credentialValue = 'Bearer catalog-secret-value';
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => response({
        body: Buffer.from(JSON.stringify({
          data: [{ id: 'safe-model', name: `echoed ${credentialValue}` }],
        })),
      }),
    });

    await expect(client.getCatalog({
      endpointUrl: 'https://models.example',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
      resolveCredential: credentialResolver({ kind: 'httpHeader', name: 'authorization', value: credentialValue }),
      ...authorizedDestination,
    })).rejects.toMatchObject({ code: 'provider_probe_response_invalid' });
  });

  it('rejects catalog fields that echo any plugin or user supplied public-header value', async () => {
    const publicHeaderValue = 'tenant-routing-value-that-must-not-be-rendered';
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport: async () => response({
        body: Buffer.from(JSON.stringify({
          data: [{ id: `echoed-${publicHeaderValue}` }],
        })),
      }),
    });

    await expect(client.getCatalog({
      endpointUrl: 'https://models.example',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: { 'x-tenant-routing': publicHeaderValue },
      ...authorizedDestination,
    })).rejects.toMatchObject({ code: 'provider_probe_response_invalid' });
  });
});

describe('provider fixed-shape model-load HTTP client', () => {
  const request = {
    endpointUrl: 'http://127.0.0.1:1234',
    path: '/api/v1/models/load',
    publicHeaders: { 'x-client': 'happier' },
    modelId: 'model/a:latest',
    authorizeDestination: async () => {},
  } as const;

  it('pins the authorized destination and emits only the fixed JSON model-id POST', async () => {
    const authorizeDestination = vi.fn(async () => undefined);
    const transport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response({ body: Buffer.alloc(0) }));
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['127.0.0.1'],
      transport,
    });

    await expect(client.postModelLoad({ ...request, authorizeDestination })).resolves.toEqual({ statusCode: 200 });
    expect(authorizeDestination).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'http://127.0.0.1:1234', scope: 'machine', locality: 'loopback',
    }));
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: 'http://127.0.0.1:1234/api/v1/models/load',
      wallTimeMs: 600_000,
      idleTimeMs: 10_000,
      body: Buffer.from('{"model":"model/a:latest"}'),
      headers: expect.objectContaining({
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength('{"model":"model/a:latest"}')),
        'x-client': 'happier',
      }),
    }));
    expect(PROVIDER_MODEL_LOAD_HTTP_LIMITS).toEqual({ wallTimeMs: 600_000, maxDecodedBodyBytes: 1_048_576 });
  });

  it('resolves bracketed IPv6 URL literals through their unwrapped hostname', async () => {
    const resolvedHostnames: string[] = [];
    const transport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response({ body: Buffer.alloc(0) }));
    const client = createProviderProbeHttpClient({
      resolveAddresses: async (hostname) => {
        resolvedHostnames.push(hostname);
        return ['::1'];
      },
      transport,
    });

    await expect(client.postModelLoad({
      ...request,
      endpointUrl: 'http://[::1]:1234',
    })).resolves.toEqual({ statusCode: 200 });
    expect(resolvedHostnames).toEqual(['::1']);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '::1',
      servername: '::1',
      validatedAddresses: ['::1'],
    }));
  });

  it('sends the fixed request through the real pinned loopback transport', async () => {
    let observed: Readonly<{ method: string | undefined; body: string }> | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        observed = { method: request.method, body: Buffer.concat(chunks).toString('utf8') };
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new TypeError('Expected a TCP test listener');
      const client = createProviderProbeHttpClient({ resolveAddresses: async () => ['127.0.0.1'] });
      await expect(client.postModelLoad({
        ...request,
        endpointUrl: `http://127.0.0.1:${address.port}`,
      })).resolves.toEqual({ statusCode: 204 });
      expect(observed).toEqual({ method: 'POST', body: '{"model":"model/a:latest"}' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects redirects without replaying the mutation or credential', async () => {
    const transport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response({
      status: 307,
      headers: { location: 'http://127.0.0.1:1234/other' },
      body: Buffer.alloc(0),
    }));
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['127.0.0.1'],
      transport,
    });
    await expect(client.postModelLoad({
      ...request,
      resolveCredential: credentialResolver({ kind: 'httpHeader', name: 'authorization', value: 'Bearer secret' }),
    })).rejects.toMatchObject({ code: 'provider_probe_response_invalid' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, false, 'provider_endpoint_auth_required'],
    [401, true, 'provider_endpoint_unauthorized'],
    [429, false, 'provider_endpoint_rate_limited'],
    [503, false, 'provider_endpoint_unavailable'],
    [418, false, 'provider_probe_response_invalid'],
  ] as const)('maps model-load HTTP %s with credential=%s to %s', async (status, withCredential, code) => {
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['127.0.0.1'],
      now: () => 1_000,
      transport: async () => response({
        status,
        headers: status === 429 ? { 'retry-after': '2' } : {},
        body: Buffer.alloc(0),
      }),
    });
    await expect(client.postModelLoad({
      ...request,
      ...(withCredential
        ? {
          resolveCredential: credentialResolver({ kind: 'httpHeader', name: 'authorization', value: 'Bearer secret' }),
        }
        : {}),
    })).rejects.toMatchObject({
      code,
      ...(status === 429 ? { retryAfterMs: 2_000 } : {}),
    });
  });

  it('enforces the one-MiB decoded response cap including compression', async () => {
    const oversized = gzipSync(Buffer.alloc(PROVIDER_MODEL_LOAD_HTTP_LIMITS.maxDecodedBodyBytes + 1));
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['127.0.0.1'],
      transport: async () => response({
        headers: { 'content-encoding': 'gzip' },
        body: oversized,
      }),
    });
    await expect(client.postModelLoad(request)).rejects.toMatchObject({ code: 'provider_probe_response_invalid' });
  });

  it('preserves cancellation and destination refusal before transport', async () => {
    const transport = vi.fn<ProviderProbeTransport>().mockResolvedValue(response());
    const client = createProviderProbeHttpClient({
      resolveAddresses: async () => ['127.0.0.1'],
      transport,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(client.postModelLoad({ ...request, signal: controller.signal }))
      .rejects.toBeInstanceOf(ProviderProbeCancelledError);
    await expect(client.postModelLoad({
      ...request,
      authorizeDestination: async () => { throw new Error('destination refused'); },
    })).rejects.toThrow('destination refused');
    expect(transport).not.toHaveBeenCalled();
  });
});
