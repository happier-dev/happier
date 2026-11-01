import { describe, expect, it, vi, beforeEach } from 'vitest';

import axios from 'axios';
import {
  buildConnectedServiceCredentialRecord,
  buildProviderAccountUsageRecordId,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
} from '@happier-dev/protocol';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import type { Credentials } from '@/persistence';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';

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
    warn: vi.fn(),
  },
}));

vi.mock('./configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
  },
}));

function createTestCredentials() {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  } satisfies Credentials;
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

function createProviderAccountUsageRecordKey(): ProviderAccountUsageRecordKeyV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId: 'acct_live_codex',
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return recordKey;
}

function createProviderAccountUsageRecordId(): string {
  return buildProviderAccountUsageRecordId(createProviderAccountUsageRecordKey());
}

function createConnectedServiceUsageSource(): ConnectedServiceUsageSourceV1 {
  return {
    serviceId: 'openai-codex',
    profileId: 'work',
    bindingKind: 'group_member',
    groupId: 'team',
    groupGeneration: 4,
  };
}

describe('ApiClient connected services v2', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });

  it('posts sealed credentials to the v2 connected services endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true, credentialRevision: 'csr_1234567890123456789012' } });

    const api = await ApiClient.create(createTestCredentials());

    const result = await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      metadata: { kind: 'oauth', providerEmail: 'user@example.com', expiresAt: Date.now() + 3600_000 },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
      refreshLeaseOwnerId: 'machine:daemon:attempt',
    });

    expect(result).toEqual({ success: true, credentialRevision: 'csr_1234567890123456789012' });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({
        expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
        refreshLeaseOwnerId: 'machine:daemon:attempt',
        sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('c2VhbGVk');
  });

  it('serializes an explicit expect-absent credential revision guard', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true, credentialRevision: 'csr_1234567890123456789012' } });

    const api = await ApiClient.create(createTestCredentials());
    await api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      expectedCredentialRevision: null,
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({ expectedCredentialRevision: null }),
      expect.any(Object),
    );
  });

  it('preserves a definite credential write rejection as a sanitized status error', async () => {
    mockPost.mockRejectedValueOnce(createAxiosResponseError({
      status: 400,
      data: { error: 'invalid_request' },
    }));
    const api = await ApiClient.create(createTestCredentials());

    await expect(api.registerConnectedServiceCredentialSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
      sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' },
      expectedCredentialRevision: null,
    })).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('does not expose the retired sealed connected-service quota writer', async () => {
    const api = await ApiClient.create(createTestCredentials());

    expect('registerConnectedServiceQuotaSnapshotSealed' in api).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('posts sealed provider account usage snapshots to the v2 canonical endpoint by record id', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true, credentialRevision: 'csr_1234567890123456789012' } });
    const recordKey = createProviderAccountUsageRecordKey();
    const recordId = buildProviderAccountUsageRecordId(recordKey);

    const api = await ApiClient.create(createTestCredentials());

    await api.registerProviderAccountUsageSnapshotSealed({
      recordId,
      recordKey,
      sealed: { format: 'account_scoped_v1', ciphertext: 'cHJvdmlkZXItdXNhZ2U=' },
      metadata: { fetchedAt: 1_000, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'fingerprint' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v2/connect/provider-account-usage/${encodeURIComponent(recordId)}`),
      expect.objectContaining({
        sealed: { format: 'account_scoped_v1', ciphertext: 'cHJvdmlkZXItdXNhZ2U=' },
        recordKey,
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

  it('posts sealed provider account usage snapshots with source context to the v2 canonical endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true, credentialRevision: 'csr_1234567890123456789012' } });
    const recordKey = createProviderAccountUsageRecordKey();
    const recordId = buildProviderAccountUsageRecordId(recordKey);

    const api = await ApiClient.create(createTestCredentials());

    await api.registerProviderAccountUsageSnapshotSealed({
      recordId,
      recordKey,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
      sealed: { format: 'account_scoped_v1', ciphertext: 'cHJvdmlkZXItdXNhZ2U=' },
      metadata: { fetchedAt: 1_000, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'fingerprint' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v2/connect/provider-account-usage/${encodeURIComponent(recordId)}`),
      expect.objectContaining({
        sealed: { format: 'account_scoped_v1', ciphertext: 'cHJvdmlkZXItdXNhZ2U=' },
        recordKey,
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

  it('logs skipped sealed provider account usage source-link outcomes from the v2 canonical endpoint', async () => {
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
    const recordKey = createProviderAccountUsageRecordKey();
    const recordId = buildProviderAccountUsageRecordId(recordKey);

    const api = await ApiClient.create(createTestCredentials());

    await api.registerProviderAccountUsageSnapshotSealed({
      recordId,
      recordKey,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
      sealed: { format: 'account_scoped_v1', ciphertext: 'cHJvdmlkZXItdXNhZ2U=' },
      metadata: { fetchedAt: 1_000, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'fingerprint' },
    });

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Provider account usage source link skipped'));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('binding_unavailable'));
  });

  it('gets sealed provider account usage snapshots from the v2 canonical endpoint by record id', async () => {
    const recordId = createProviderAccountUsageRecordId();
    const source = createConnectedServiceUsageSource();
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'cHJvdmlkZXItdXNhZ2U=' },
        metadata: { fetchedAt: 1_000, staleAfterMs: 300_000, status: 'ok' },
        sources: [source],
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    const res = await api.getProviderAccountUsageSnapshotSealed({ recordId });

    expect(res?.sealed).toEqual({ format: 'account_scoped_v1', ciphertext: 'cHJvdmlkZXItdXNhZ2U=' });
    expect(res?.sources).toEqual([source]);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining(`/v2/connect/provider-account-usage/${encodeURIComponent(recordId)}`),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
    expect(String(vi.mocked(axios.get).mock.calls[0]?.[0])).not.toContain('/profiles/');
  });

  it('gets sealed quota snapshots from the v2 connected services quotas endpoint', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'cXVvdGEtY2lwaGVydGV4dA==' },
        metadata: { fetchedAt: Date.now(), staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    const res = await api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(res?.sealed?.ciphertext).toBe('cXVvdGEtY2lwaGVydGV4dA==');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v2/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('returns null for missing sealed quota snapshots', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 404,
      data: { error: 'connect_quota_snapshot_not_found' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toBeNull();
  });

  it.each([401, 403] as const)('classifies auth quota read failures by status %i', async (status) => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status,
      data: { error: 'not_authenticated' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'auth',
      status,
      retryable: false,
      quotaFetchErrorCode: 'auth_failure',
    });
  });

  it('preserves retry-after timing for quota rate limits', async () => {
    const cause = createAxiosResponseError({
      status: 429,
      data: { error: 'rate_limited' },
      headers: { 'retry-after': '7' },
    });
    mockGet.mockRejectedValue(cause);

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'retryable',
      status: 429,
      retryable: true,
      retryAfterMs: 7_000,
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
        retryAfterMs: 7_000,
      },
    });
  });

  it('classifies server quota failures as retryable while preserving status', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 503,
      data: { error: 'server_unavailable' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotSealed({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'retryable',
      status: 503,
      retryable: true,
    });
  });

  it('resolves machine SCM credentials from the primary connected profile when multiple profiles are available', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'github-work-access-token',
        refreshToken: 'github-work-refresh-token',
        idToken: null,
        scope: 'repo read:user',
        tokenType: 'Bearer',
        providerAccountId: '42',
        providerEmail: 'work@example.com',
      },
    });
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: createTestCredentials().encryption,
      payload: record,
      randomBytes: (len) => new Uint8Array(len).fill(1),
    });

    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/v2/connect/github/profiles/work/credential')) {
        return {
          status: 200,
          data: {
            credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            sealed: { format: 'account_scoped_v1', ciphertext },
            metadata: {
              kind: 'oauth',
              providerEmail: 'work@example.com',
              providerAccountId: '42',
            },
          },
        };
      }

      if (url.includes('/v2/connect/github/profiles')) {
        return {
          status: 200,
          data: {
            serviceId: 'github',
            profiles: [
              { profileId: 'work', status: 'connected', kind: 'oauth' },
              { profileId: 'personal', status: 'connected', kind: 'token' },
            ],
          },
        };
      }

      return {
        status: 404,
        data: { error: 'connect_credential_not_found' },
      };
    });

    const api = await ApiClient.create(createTestCredentials());
    const resolver = (
      api as unknown as { createConnectedAccountCredentialResolver(): ScmConnectedAccountCredentialResolver }
    ).createConnectedAccountCredentialResolver();

    await expect(resolver.resolveCredential('github')).resolves.toMatchObject({
      serviceId: 'github',
      profileId: 'work',
      kind: 'oauth',
    });
    const requestedUrls = mockGet.mock.calls.map((call) => String(call[0]));
    expect(requestedUrls).toEqual(expect.arrayContaining([
      expect.stringContaining('/v1/account/encryption'),
      expect.stringContaining('/v2/connect/github/profiles'),
      expect.stringContaining('/v2/connect/github/profiles/work/credential'),
    ]));
  });

  it('accepts all connected-service profile health statuses from the server', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        serviceId: 'openai-codex',
        profiles: [
          { profileId: 'connected', status: 'connected', kind: 'oauth' },
          { profileId: 'reauth', status: 'needs_reauth', kind: 'oauth' },
          { profileId: 'refreshing', status: 'refreshing', kind: 'oauth' },
          { profileId: 'retryable', status: 'refresh_failed_retryable', kind: 'oauth' },
        ],
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toEqual({
      serviceId: 'openai-codex',
      profiles: [
        expect.objectContaining({ profileId: 'connected', status: 'connected' }),
        expect.objectContaining({ profileId: 'reauth', status: 'needs_reauth' }),
        expect.objectContaining({ profileId: 'refreshing', status: 'refreshing' }),
        expect.objectContaining({ profileId: 'retryable', status: 'refresh_failed_retryable' }),
      ],
    });
  });

  it('shares concurrent and fresh connected-service profile list requests', async () => {
    let resolveProfiles: ((value: unknown) => void) | undefined;
    mockGet.mockReturnValueOnce(new Promise((resolve) => {
      resolveProfiles = resolve;
    }));

    const api = await ApiClient.create(createTestCredentials());

    const first = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });
    const second = api.listConnectedServiceProfiles({ serviceId: 'openai-codex' });

    expect(mockGet).toHaveBeenCalledTimes(1);

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

    mockGet.mockResolvedValueOnce({
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
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('bypasses the connected-service profile cache for an authoritative inventory read', async () => {
    mockGet
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
          profiles: [{ profileId: 'current', status: 'connected', kind: 'oauth' }],
        },
      });
    const api = await ApiClient.create(createTestCredentials());

    await expect(api.listConnectedServiceProfiles({ serviceId: 'openai-codex' })).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'old' })],
    });
    await expect(api.listConnectedServiceProfiles({
      serviceId: 'openai-codex',
      forceRefresh: true,
    })).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'current' })],
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('invalidates connected-service profile list cache after sealed credential writes', async () => {
    mockGet
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
    mockPost.mockResolvedValue({ status: 200, data: { success: true, credentialRevision: 'csr_1234567890123456789012' } });

    const api = await ApiClient.create(createTestCredentials());

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
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
