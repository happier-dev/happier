import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import { readHttpStatus } from './client/httpStatusError';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

const { mockPost, mockPatch, mockGet, mockFetchServerFeaturesSnapshot } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockGet: vi.fn(),
  mockFetchServerFeaturesSnapshot: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost, patch: mockPatch, get: mockGet, isAxiosError: vi.fn(() => true) },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: mockFetchServerFeaturesSnapshot,
}));

vi.mock('./configuration', () => ({
  configuration: {
    apiServerUrl: 'https://api.example.com',
  },
}));

function createAxiosResponseError(params: Readonly<{
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}>): Error & {
  response: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
} {
  const error = new Error(`Request failed with status ${params.status}`) as Error & {
    response: {
      status: number;
      data: unknown;
      headers: Record<string, string>;
    };
  };
  error.response = {
    status: params.status,
    data: params.data ?? { error: 'request_failed' },
    headers: params.headers ?? {},
  };
  return error;
}

describe('ApiClient connected services v3 credentials', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPatch.mockReset();
    mockGet.mockReset();
    mockFetchServerFeaturesSnapshot.mockReset();
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
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
    mockFetchServerFeaturesSnapshot.mockResolvedValue(authoritative);
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    api.setServerFeaturesSnapshotProvider(() => cached as unknown as CliServerFeaturesSnapshot);

    await expect(api.getServerFeaturesSnapshot({ refresh: true })).resolves.toBe(authoritative);
    await expect(api.getServerFeaturesSnapshot()).resolves.toBe(cached);
    expect(mockFetchServerFeaturesSnapshot).toHaveBeenCalledWith({
      serverUrl: expect.any(String),
    });
  });

  it('rejects a v3 credential whose embedded binding does not match the requested route', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'other-profile',
      kind: 'token',
      token: { token: 'setup-token', providerAccountId: null, providerEmail: null },
    });
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        content: { t: 'plain', v: record },
      },
    });

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

  it('posts plaintext credentials without logging credential secrets', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: { success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
    });

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

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential'),
      {
        content: { t: 'plain', v: record },
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer happy-token' }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('serializes the server-v0.2.1 token discriminator with oauth:null as content-only', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: { success: true },
    });
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

    expect(mockPost.mock.calls[0]?.[1]).toEqual({
      content: { t: 'plain', v: releasedRecord },
    });
  });

  it('returns typed supersession for a revision-fenced plaintext credential mutation', async () => {
    mockPost.mockRejectedValue(createAxiosResponseError({
      status: 409,
      data: {
        error: 'connect_credential_mutation_superseded',
        reason: 'revision_mismatch',
        credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
      },
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
    mockPost.mockRejectedValue(createAxiosResponseError({
      status: 400,
      data: { error: 'invalid-params', echoedSecret: 'plain-request-secret' },
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
    mockPost.mockRejectedValue(createAxiosResponseError({
      status: 503,
      data: { error: 'server_unavailable' },
      headers: { 'retry-after': '3' },
    }));

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
    mockPatch.mockRejectedValue(createAxiosResponseError({
      status: 429,
      data: { error: 'rate_limited' },
      headers: { 'retry-after': '4' },
    }));

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
