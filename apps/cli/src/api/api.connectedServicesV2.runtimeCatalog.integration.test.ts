import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { buildConnectedServiceCredentialRecord, FeaturesResponseSchema } from '@happier-dev/protocol';

import { ApiClient } from './api';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import { readHttpStatus } from './client/httpStatusError';
import { storeConnectedServiceCredentialForAccount } from '@/cloud/connectedServices/storeConnectedServiceCredentialForAccount';

type HttpReply = { status: number; data?: unknown; headers?: Record<string, string> };
const getResponse = vi.fn<() => Promise<HttpReply>>();
const postResponse = vi.fn<() => Promise<HttpReply>>();
const patchResponse = vi.fn<() => Promise<HttpReply>>();
const currentHomeFeatures = FeaturesResponseSchema.parse({
  features: {},
  capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: true } } },
});

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('ApiClient connected services v2', () => {
  let app: FastifyInstance;
  let restoreAdapter: () => void;
  let requests: Array<Pick<FastifyRequest, 'method' | 'url' | 'headers' | 'body'>>;
  const responses = { GET: getResponse, POST: postResponse, PATCH: patchResponse };

  beforeEach(() => {
    requests = [];
    app = fastify();
    app.route({
      method: ['GET', 'POST', 'PATCH'],
      url: '/*',
      async handler({ method, url, headers, body }, reply) {
        requests.push({ method, url, headers, body });
        const response = await responses[method as keyof typeof responses]();
        if (!response) throw new Error('Missing HTTP response fixture for ' + method + ' ' + url);
        return reply.code(response.status).headers(response.headers ?? {}).send(response.data);
      },
    });
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
    postResponse.mockReset();
    getResponse.mockReset();
    patchResponse.mockReset();
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });

  afterEach(async () => {
    restoreAdapter();
    vi.unstubAllGlobals();
    resetServerFeaturesClientForTests();
    await app.close();
  });

  it('posts sealed credentials to the v2 connected services endpoint', async () => {
    postResponse.mockResolvedValue({
      status: 200,
      data: { success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const outcome = await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      metadata: { kind: 'oauth', providerEmail: 'user@example.com', expiresAt: Date.now() + 3600_000 },
    });

    expect(outcome).toEqual({
      success: true,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });

    expect(requests).toContainEqual(expect.objectContaining({
      method: 'POST',
      url: expect.stringContaining('/v2/connect/openai-codex/profiles/work/credential'),
      body: expect.objectContaining({
        sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      }),
      headers: expect.objectContaining({
          authorization: 'Bearer happy-token',
        }),
    }));

    const serializedLogs = JSON.stringify((logger as any).debug.mock.calls);
    expect(serializedLogs).not.toContain('c2VhbGVk');
  });

  it('preserves a sanitized deterministic 400 so bounded storage does not settle or retry', async () => {
    getResponse
      .mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 404 });
    postResponse.mockResolvedValue({ status: 400, data: { error: 'invalid-params', echoedSecret: 'server-secret-echo' } });

    const origin = new URL(resolveServerHttpBaseUrl()).origin;
    app.get('/v1/features', async () => currentHomeFeatures);
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe(origin);
      expect(init?.method).toBe('GET');
      expect(url.pathname).toBe('/v1/features');
      const response = await app.inject({ method: 'GET', url: url.pathname });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    });
    const credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    };
    const api = await ApiClient.create(credentials);
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'provider-request-secret', providerAccountId: null, providerEmail: null },
    });

    let thrown: unknown;
    try {
      await storeConnectedServiceCredentialForAccount({ api, credentials, record });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: 'HttpStatusError', response: { status: 400 } });
    expect(readHttpStatus(thrown)).toBe(400);
    const writes = requests.filter(request => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(requests.filter(request => request.method === 'GET')).toHaveLength(2);
    const written = writes[0]!;
    const writtenBody = written.body as { sealed: { ciphertext: string } };
    const authorization = written.headers.authorization;
    expect(authorization).toBeDefined();
    expect(writtenBody.sealed.ciphertext).not.toBe('');
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain(authorization!);
    expect(serialized).not.toContain(writtenBody.sealed.ciphertext);
    expect(serialized).not.toContain('happy-token');
    expect(serialized).not.toContain('provider-request-secret');
    expect(serialized).not.toContain('server-secret-echo');
  });

  it('does not expose the retired sealed connected-service quota writer', async () => {
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    expect('registerConnectedServiceQuotaSnapshotSealed' in api).toBe(false);
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('preserves status, retry-after, and cause for failed sealed quota reads', async () => {
    getResponse.mockResolvedValue({
      status: 429,
      headers: { 'retry-after': '2' },
      data: { error: 'rate_limited' },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 2_000,
      cause: { name: 'AxiosError', response: { status: 429, data: { error: 'rate_limited' } } },
    });
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect((logger.debug as any).mock.calls[0]?.[0]).toContain('temporarily unavailable');
    expect((logger.debug as any).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect((logger.debug as any).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'rate_limited',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 2_000,
      },
    });
  });

  it('gets sealed quota snapshots from the v2 connected services quotas endpoint', async () => {
    getResponse.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
        metadata: { fetchedAt: Date.now(), staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const res = await api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(res?.sealed?.ciphertext).toBe('cXVvdGEtY2lwaGVydGV4dA==');
    expect(requests).toContainEqual(expect.objectContaining({
      method: 'GET',
      url: expect.stringContaining('/v2/connect/openai-codex/profiles/work/quotas'),
      headers: expect.objectContaining({
          authorization: 'Bearer happy-token',
        }),
    }));
  });

  it('uses the canonical v3 credential health endpoint', async () => {
    patchResponse.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRuntimeAuthFailureAt: 1_000,
      },
    });

    expect(requests).toContainEqual(expect.objectContaining({
      method: 'PATCH',
      url: expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential/health'),
      body: {
        health: {
          v: 1,
          status: 'needs_reauth',
          reconnectRequired: true,
          lastRuntimeAuthFailureAt: 1_000,
        },
      },
      headers: expect.objectContaining({
          authorization: 'Bearer happy-token',
        }),
    }));
  });

  it('sends owner ids when acquiring connected service refresh leases', async () => {
    postResponse.mockResolvedValue({
      status: 200,
      data: {
        acquired: true,
        leaseUntil: 2_000,
        ownerId: 'machine-1:daemon-a',
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const lease = await api.acquireConnectedServiceRefreshLease({
      serviceId: 'openai-codex',
      profileId: 'work',
      machineId: 'machine-1',
      ownerId: 'machine-1:daemon-a',
      leaseMs: 10_000,
    });

    expect(lease).toEqual({
      acquired: true,
      leaseUntil: 2_000,
      ownerId: 'machine-1:daemon-a',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });

    expect(requests).toContainEqual(expect.objectContaining({
      method: 'POST',
      url: expect.stringContaining('/v3/connect/openai-codex/profiles/work/refresh-lease'),
      body: { machineId: 'machine-1', ownerId: 'machine-1:daemon-a', leaseMs: 10_000 },
      headers: expect.objectContaining({
          authorization: 'Bearer happy-token',
        }),
    }));
  });

  it('shares concurrent and fresh connected-service profile list requests', async () => {
    let resolveProfiles: ((value: HttpReply) => void) | undefined;
    getResponse.mockReturnValueOnce(new Promise((resolve) => {
      resolveProfiles = resolve;
    }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const first = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });
    const second = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });

    await vi.waitFor(() => expect(requests.filter(request => request.method === 'GET')).toHaveLength(1));

    resolveProfiles?.({
      status: 200,
      data: {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'connected', status: 'connected', kind: 'oauth' }],
      },
    });

    await expect(first).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });
    await expect(second).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });

    getResponse.mockResolvedValueOnce({
      status: 200,
      data: {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'fresh', status: 'connected', kind: 'oauth' }],
      },
    });

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      serviceId: 'openai-codex',
      profiles: [expect.objectContaining({ profileId: 'connected' })],
    });
    expect(requests.filter(request => request.method === 'GET')).toHaveLength(1);
  });

  it('invalidates connected-service profile list cache after sealed credential writes', async () => {
    getResponse
      .mockResolvedValueOnce({
        status: 200,
        data: {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'old', status: 'connected', kind: 'oauth' }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new', status: 'connected', kind: 'oauth' }],
        },
      });
    postResponse.mockResolvedValue({
      status: 200,
      data: { success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'old' })],
    });

    await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'new',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
    });

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'new' })],
    });
    expect(requests.filter(request => request.method === 'GET')).toHaveLength(2);
  });
});
