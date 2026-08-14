import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import type { Credentials } from '@/persistence';
import {
  buildConnectedServiceCredentialRecord,
  buildProviderAccountUsageRecordId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost, get: mockGet, isAxiosError: vi.fn(() => true) },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

function createTestCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

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

function createProviderAccountUsageSnapshot(): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId: 'acct_live_codex',
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: 'acct_live_codex' },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_empty',
    planLabel: null,
    accountLabel: null,
    meters: [],
  };
}

function createConnectedServiceUsageSource(): Extract<ConnectedServiceUsageSourceV1, { bindingKind: 'group_member' }> {
  return {
    serviceId: 'openai-codex',
    profileId: 'work',
    bindingKind: 'group_member',
    groupId: 'team',
    groupGeneration: 4,
  };
}

describe('ApiClient connected services quotas v3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });

  it('gets the account encryption mode from /v1/account/encryption', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    const api = await ApiClient.create(createTestCredentials());

    const mode = await api.getAccountEncryptionMode();
    expect(mode).toBe('plain');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/account/encryption'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('forwards cancellation for an uncached account encryption mode probe', async () => {
    const controller = new AbortController();
    mockGet.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getAccountEncryptionModeUncached({ signal: controller.signal })).resolves.toBe('plain');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/account/encryption'),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('shares concurrent and fresh account encryption mode lookups', async () => {
    let resolveMode: ((value: unknown) => void) | undefined;
    mockGet.mockReturnValueOnce(new Promise((resolve) => {
      resolveMode = resolve;
    }));

    const api = await ApiClient.create(createTestCredentials());

    const first = api.getAccountEncryptionMode();
    const second = api.getAccountEncryptionMode();

    expect(mockGet).toHaveBeenCalledTimes(1);

    resolveMode?.({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    await expect(first).resolves.toBe('plain');
    await expect(second).resolves.toBe('plain');

    await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('bypasses a cached account mode for an immediately guarded credential write', async () => {
    mockGet
      .mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 2 } });
    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
    await expect(api.getAccountEncryptionMode({ refresh: true })).resolves.toBe('e2ee');

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['service', { serviceId: 'claude-subscription' as const, profileId: 'work' }],
    ['profile', { serviceId: 'openai-codex' as const, profileId: 'other' }],
  ])('rejects a valid v3 credential whose embedded %s does not match the requested binding', async (_field, embedded) => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: embedded.serviceId,
      profileId: embedded.profileId,
      kind: 'token',
      token: {
        token: 'credential-secret-not-for-errors',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        content: { t: 'plain', v: record },
      },
    });

    const api = await ApiClient.create(createTestCredentials());
    await expect(api.getConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toThrow('Failed to get connected service credential: Invalid connected service credential response');
  });

  it('returns unknown when account encryption mode lookup fails', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 503,
      data: { error: 'server_unavailable' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
  });

  it('samples transient account encryption mode failures without error-labeled logs', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 503,
      data: { error: 'server_unavailable' },
      headers: { 'retry-after': '2' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).toBe(
      '[API] Failed to get account encryption mode temporarily unavailable; will retry or recover when the server is ready.',
    );
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'server_error',
        retryable: true,
        statusCode: 503,
        retryAfterMs: 2_000,
      },
    });
  });

  it('gets plaintext quota snapshots from the v3 connected services quotas endpoint', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        content: {
          t: 'plain',
          v: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 300_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
          },
        },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    const res = await api.getConnectedServiceQuotaSnapshotPlain({ serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.content?.v?.serviceId).toBe('openai-codex');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('samples transient plaintext quota snapshot failures without error-labeled logs', async () => {
    const cause = createAxiosResponseError({
      status: 429,
      data: { error: 'rate_limited' },
      headers: { 'retry-after': '2' },
    });
    mockGet.mockRejectedValue(cause);

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'retryable',
      status: 429,
      retryable: true,
      retryAfterMs: 2_000,
      cause,
    });
    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).toContain('temporarily unavailable');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'rate_limited',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 2_000,
      },
    });
  });

  it('does not expose the retired plaintext connected-service quota writer', async () => {
    const api = await ApiClient.create(createTestCredentials());

    expect('registerConnectedServiceQuotaSnapshotPlain' in api).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('posts plaintext provider account usage snapshots to the v3 canonical endpoint by record id', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });
    const snapshot = createProviderAccountUsageSnapshot();

    const api = await ApiClient.create(createTestCredentials());

    await api.registerProviderAccountUsageSnapshotPlain({
      recordId: snapshot.recordId,
      content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: 1_000, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'fingerprint' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`),
      expect.objectContaining({
        content: { t: 'plain', v: snapshot },
        metadata: expect.objectContaining({ materialFingerprint: 'fingerprint' }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
    expect(String(vi.mocked(axios.post).mock.calls[0]?.[0])).not.toContain('/profiles/');
  });

  it('posts plaintext provider account usage snapshots with source context to the v3 canonical endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });
    const snapshot = createProviderAccountUsageSnapshot();

    const api = await ApiClient.create(createTestCredentials());

    await api.registerProviderAccountUsageSnapshotPlain({
      recordId: snapshot.recordId,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
      content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: 1_000, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'fingerprint' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`),
      expect.objectContaining({
        content: { t: 'plain', v: snapshot },
        source: {
          serviceId: 'openai-codex',
          profileId: 'work',
          bindingKind: 'profile',
        },
        metadata: expect.objectContaining({ materialFingerprint: 'fingerprint' }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
    expect(String(vi.mocked(axios.post).mock.calls[0]?.[0])).not.toContain('/profiles/');
  });

  it('logs skipped plaintext provider account usage source-link outcomes from the v3 canonical endpoint', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        source: {
          status: 'skipped',
          reason: 'binding_unavailable',
        },
      },
    });
    const snapshot = createProviderAccountUsageSnapshot();

    const api = await ApiClient.create(createTestCredentials());

    await api.registerProviderAccountUsageSnapshotPlain({
      recordId: snapshot.recordId,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
      content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: 1_000, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'fingerprint' },
    });

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Provider account usage source link skipped'));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('binding_unavailable'));
  });

  it('gets plaintext provider account usage snapshots from the v3 canonical endpoint by record id', async () => {
    const snapshot = createProviderAccountUsageSnapshot();
    const source = createConnectedServiceUsageSource();
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: 1_000, staleAfterMs: 300_000, status: 'ok' },
        sources: [source],
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    const res = await api.getProviderAccountUsageSnapshotPlain({ recordId: snapshot.recordId });

    expect(res?.content).toEqual({ t: 'plain', v: snapshot });
    expect(res?.sources).toEqual([source]);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
    expect(String(vi.mocked(axios.get).mock.calls[0]?.[0])).not.toContain('/profiles/');
  });

  it('resolves the exact current provider-account usage source with its full ownership proof', async () => {
    const snapshot = createProviderAccountUsageSnapshot();
    const source = createConnectedServiceUsageSource();
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        source,
        recordId: snapshot.recordId,
        providerAccountId: 'acct_live_codex',
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.resolveProviderAccountUsageSource({ source })).resolves.toEqual({
      source,
      recordId: snapshot.recordId,
      providerAccountId: 'acct_live_codex',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
    });
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/provider-account-usage/sources/resolve'),
      expect.objectContaining({
        params: source,
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('returns null when the exact provider-account usage source is not current', async () => {
    const source = createConnectedServiceUsageSource();
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 404,
      data: { error: 'provider_account_usage_source_not_found' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.resolveProviderAccountUsageSource({ source })).resolves.toBeNull();
  });

  it('does not treat an unrelated HTTP 404 as authoritative exact-source absence', async () => {
    const source = createConnectedServiceUsageSource();
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 404,
      data: { error: 'route_not_found' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.resolveProviderAccountUsageSource({ source })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'http',
      status: 404,
      retryable: false,
    });
  });

  it('rejects malformed exact-source ownership proof as a protocol error', async () => {
    const source = createConnectedServiceUsageSource();
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        source,
        recordId: 'not-a-record-id',
        providerAccountId: 'acct_live_codex',
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.resolveProviderAccountUsageSource({ source })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'protocol',
      retryable: false,
    });
  });

  it('rejects an exact-source response for a different source tuple', async () => {
    const snapshot = createProviderAccountUsageSnapshot();
    const source = createConnectedServiceUsageSource();
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        source: { ...source, groupGeneration: source.groupGeneration! + 1 },
        recordId: snapshot.recordId,
        providerAccountId: 'acct_live_codex',
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.resolveProviderAccountUsageSource({ source })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'protocol',
      retryable: false,
    });
  });

  it('classifies plaintext quota read timeouts as retryable', async () => {
    const cause = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    mockGet.mockRejectedValue(cause);

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'retryable',
      status: null,
      retryable: true,
      cause,
    });
  });

  it('preserves invalid plaintext quota payloads as protocol errors', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        content: { t: 'plain', v: { serviceId: 'openai-codex' } },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'protocol',
      status: null,
      retryable: false,
    });
  });

  it('returns null for missing plaintext quota snapshots', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 404,
      data: { error: 'connect_quota_snapshot_not_found' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toBeNull();
  });
});
