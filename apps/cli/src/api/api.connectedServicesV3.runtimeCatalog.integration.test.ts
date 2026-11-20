import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fastify, { type FastifyInstance } from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ApiClient, ConnectedServiceCredentialUnsupportedFormatError } from './api';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import { readHttpStatus } from './client/httpStatusError';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

const credentialPath = '/v3/connect/openai-codex/profiles/work/credential';

describe('ApiClient connected services v3 credentials', () => {
  let app: FastifyInstance;
  let restoreAdapter: () => void;
  let requests: Array<{ body: unknown; authorization: string | undefined }>;

  beforeEach(() => {
    app = fastify();
    requests = [];
    app.addHook('preHandler', async (request) => {
      requests.push({ body: request.body, authorization: request.headers.authorization });
    });
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
    resetServerFeaturesClientForTests();
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    resetServerFeaturesClientForTests();
    restoreAdapter();
    await app.close();
  });

  it('force-refreshes server features instead of trusting a warm cached contract', async () => {
    const cached = { status: 'ready', features: { features: {}, capabilities: {} } } as const;
    const authoritative = {
      status: 'ready',
      features: {
        features: {
          sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
          },
        },
        capabilities: {},
      },
    } as const;
    // HTTP is the boundary. Seed the real public cache, then change the Home's
    // response without changing URL so refresh must observe the newer contract.
    let responseFeatures = cached.features;
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${resolveServerHttpBaseUrl()}/v1/features`);
      return new Response(JSON.stringify(responseFeatures), { status: 200 });
    });
    await expect(fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl() })).resolves.toMatchObject(cached);
    responseFeatures = authoritative.features;
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    api.setServerFeaturesSnapshotProvider(() => cached as unknown as CliServerFeaturesSnapshot);

    await expect(api.getServerFeaturesSnapshot({ refresh: true })).resolves.toMatchObject(authoritative);
    await expect(api.getServerFeaturesSnapshot()).resolves.toBe(cached);
  });

  it('refreshes through the installed daemon snapshot owner when available', async () => {
    const cached = { status: 'ready', features: { features: {}, capabilities: {} } } as const;
    const refreshed = { status: 'unsupported', reason: 'endpoint_missing' } as const;
    const refresh = vi.fn(async () => refreshed as CliServerFeaturesSnapshot);
    vi.stubGlobal('fetch', async () => { throw new Error('The installed daemon owner must own refresh'); });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    api.setServerFeaturesSnapshotProvider(
      () => cached as unknown as CliServerFeaturesSnapshot,
      refresh,
    );

    await expect(api.getServerFeaturesSnapshot({ refresh: true })).resolves.toBe(refreshed);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects a v3 credential whose embedded binding does not match the requested route', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'other-profile',
      kind: 'token',
      token: { token: 'setup-token', providerAccountId: null, providerEmail: null },
    });
    app.get(credentialPath, async () => ({
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        content: { t: 'plain', v: record },
      }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });

    await expect(api.getConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toThrow('Invalid connected service credential response');
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('setup-token');
  });

  it('preserves unsupported stored credential content as a typed failure instead of absence', async () => {
    app.get(credentialPath, async (_request, reply) =>
      reply.code(409).send({ error: 'connect_credential_unsupported_format' }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });

    await expect(api.getConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialUnsupportedFormatError',
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    await expect(api.getConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toBeInstanceOf(ConnectedServiceCredentialUnsupportedFormatError);
  });

  it('keeps a genuine missing v3 credential as absence', async () => {
    app.get(credentialPath, async (_request, reply) =>
      reply.code(404).send({ error: 'connect_credential_not_found' }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });

    await expect(api.getConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toBeNull();
  });

  it('posts plaintext credentials without logging credential secrets', async () => {
    app.post(credentialPath, async () => ({ success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuv' }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const outcome = await api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    });

    expect(outcome).toEqual({
      success: true,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });

    expect(requests).toEqual([{
      body: { content: { t: 'plain', v: record } },
      authorization: 'Bearer happy-token',
    }]);

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('serializes the server-v0.2.1 token discriminator with oauth:null as content-only', async () => {
    app.post(credentialPath, async () => ({ success: true }));
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'setup-token', providerAccountId: null, providerEmail: null },
    });
    if (record.kind !== 'token') throw new Error('Expected token credential');
    const releasedRecord = { ...record, oauth: null };

    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    })).resolves.toEqual({ success: true });

    expect(requests[0]?.body).toEqual({
      content: { t: 'plain', v: releasedRecord },
    });
  });

  it('returns typed supersession for a revision-fenced plaintext credential mutation', async () => {
    app.post(credentialPath, async (_request, reply) =>
      reply.code(409).send({
        error: 'connect_credential_mutation_superseded',
        reason: 'revision_mismatch',
        credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
      }));
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'setup-token', providerAccountId: null, providerEmail: null },
    });

    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
      refreshLeaseOwnerId: 'machine-1:daemon-a',
    })).resolves.toEqual({
      error: 'connect_credential_mutation_superseded',
      reason: 'revision_mismatch',
      credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
    });
  });

  it('preserves a sanitized deterministic status for a non-typed plaintext mutation failure', async () => {
    app.post(credentialPath, async (_request, reply) =>
      reply.code(400).send({ error: 'invalid-params', echoedSecret: 'plain-request-secret' }));
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'setup-token-secret', providerAccountId: null, providerEmail: null },
    });

    let thrown: unknown;
    try {
      await api.registerConnectedServiceCredentialPlain({
        serviceId: 'openai-codex',
        profileId: 'work',
        content: { t: 'plain', v: record },
        expectedCredentialRevision: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(readHttpStatus(thrown)).toBe(400);
    expect(thrown).toMatchObject({ name: 'HttpStatusError', response: { status: 400 } });
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain('happy-token');
    expect(serialized).not.toContain('setup-token-secret');
    expect(serialized).not.toContain('plain-request-secret');
  });

  it('samples transient plaintext credential registration failures without error-labeled logs', async () => {
    app.post(credentialPath, async (_request, reply) =>
      reply.code(503).headers({ 'retry-after': '3' }).send({ error: 'server_unavailable' }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    })).rejects.toThrow('Failed to register connected service credential');
    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    })).rejects.toThrow('Failed to register connected service credential');

    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).toBe(
      '[API] Failed to register connected service credential temporarily unavailable; will retry or recover when the server is ready.',
    );
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'server_error',
        retryable: true,
        statusCode: 503,
        retryAfterMs: 3_000,
      },
    });
    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('samples transient credential health update failures without error-labeled logs', async () => {
    app.patch(credentialPath + '/health', async (_request, reply) =>
      reply.code(429).headers({ 'retry-after': '4' }).send({ error: 'rate_limited' }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });

    await expect(api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'network_error',
        lastRefreshFailureAt: 1234,
      },
    })).rejects.toThrow('Failed to update connected service credential health');
    await expect(api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'network_error',
        lastRefreshFailureAt: 1234,
      },
    })).rejects.toThrow('Failed to update connected service credential health');

    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).toBe(
      '[API] Failed to update connected service credential health temporarily unavailable; will retry or recover when the server is ready.',
    );
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'rate_limited',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 4_000,
      },
    });
  });
});
