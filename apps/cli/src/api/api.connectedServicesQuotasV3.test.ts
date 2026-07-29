import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceQuotaRecoveryCreditsV1,
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

const predecessorRecoveryCredits = {
  kind: 'usage_limit_resets',
  availableCount: 1,
  totalCount: 1,
  nextExpiresAtMs: 2_000,
  source: 'provider_api',
  confidence: 'exact',
  credits: [{
    providerCreditId: 'credit-1',
    kind: 'rate_limit_reset',
    status: 'available',
    providerResetType: 'five_hour',
    appliesToProviderLimitId: 'five-hour',
    title: null,
    description: 'Reset the five-hour limit',
    grantedAtMs: null,
    expiresAtMs: 2_000,
    redeemStartedAtMs: null,
    redeemedAtMs: null,
  }],
} as const;

const canonicalRecoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 = {
  availableCount: 1,
  totalCount: 1,
  nextExpiresAtMs: 2_000,
  source: 'provider_api',
  confidence: 'exact',
  credits: [{
    id: 'credit-1',
    kind: 'rate_limit_reset',
    status: 'available',
    providerResetType: 'five_hour',
    appliesToProviderLimitId: 'five-hour',
    title: null,
    description: 'Reset the five-hour limit',
    grantedAtMs: null,
    expiresAtMs: 2_000,
    redeemStartedAtMs: null,
    redeemedAtMs: null,
  }],
};

describe('ApiClient connected services quotas v3', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });

  it('resolves one exact current provider-account usage source', async () => {
    const source = {
      serviceId: 'openai-codex' as const,
      profileId: 'work',
      bindingKind: 'profile' as const,
    };
    const recordId = buildProviderAccountUsageRecordId({
      providerId: 'codex',
      accountSubjectId: 'acct-work',
      subjectKind: 'account',
      quotaScope: 'account',
    });
    mockGet.mockResolvedValue({
      status: 200,
      data: { source, recordId, providerAccountId: 'acct-work', fetchedAt: 1, staleAfterMs: 60_000 },
    });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as never);

    await expect(api.resolveProviderAccountUsageSource({ source })).resolves.toMatchObject({
      source,
      recordId,
      providerAccountId: 'acct-work',
    });
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/provider-account-usage/sources/resolve'),
      expect.objectContaining({ params: source }),
    );
  });

  it('gets the account encryption mode from /v1/account/encryption', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const mode = await (api as any).getAccountEncryptionMode();
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

  it('shares concurrent and fresh account encryption mode lookups', async () => {
    let resolveMode: ((value: unknown) => void) | undefined;
    mockGet.mockReturnValueOnce(new Promise((resolve) => {
      resolveMode = resolve;
    }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const first = (api as any).getAccountEncryptionMode();
    const second = (api as any).getAccountEncryptionMode();

    expect(mockGet).toHaveBeenCalledTimes(1);

    resolveMode?.({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    await expect(first).resolves.toBe('plain');
    await expect(second).resolves.toBe('plain');

    await expect((api as any).getAccountEncryptionMode()).resolves.toBe('plain');
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh account encryption mode lookup while an older shared lookup is in flight', async () => {
    let resolveOlder: ((value: unknown) => void) | undefined;
    let resolveFresh: ((value: unknown) => void) | undefined;
    mockGet
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOlder = resolve;
      }))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFresh = resolve;
      }));

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const older = (api as any).getAccountEncryptionMode();
    const fresh = (api as any).getAccountEncryptionMode({ refresh: true });

    expect(mockGet).toHaveBeenCalledTimes(2);
    resolveFresh?.({ status: 200, data: { mode: 'plain', updatedAt: 2 } });
    await expect(fresh).resolves.toBe('plain');

    resolveOlder?.({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    await expect(older).resolves.toBe('e2ee');

    await expect((api as any).getAccountEncryptionMode()).resolves.toBe('plain');
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('returns unknown when the account encryption mode probe fails with a non-404 status', async () => {
    mockGet.mockRejectedValue({
      response: {
        status: 503,
        headers: { 'retry-after': '1' },
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect((api as any).getAccountEncryptionMode()).resolves.toBe('unknown');
  });

  it('samples transient account encryption mode failures without error-labeled logs', async () => {
    mockGet.mockRejectedValue({
      response: {
        status: 503,
        headers: { 'retry-after': '2' },
        data: { error: 'server_unavailable' },
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect((api as any).getAccountEncryptionMode()).resolves.toBe('unknown');

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect((logger.debug as any).mock.calls[0]?.[0]).toContain('temporarily unavailable');
    expect((logger.debug as any).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect((logger.debug as any).mock.calls[0]?.[1]).toMatchObject({
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
            recoveryCredits: predecessorRecoveryCredits,
            meters: [],
          },
        },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const res = await (api as any).getConnectedServiceQuotaSnapshotPlain({ serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.content?.v?.serviceId).toBe('openai-codex');
    expect(res?.content?.v?.recoveryCredits).toEqual(canonicalRecoveryCredits);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('does not expose the retired plaintext connected-service quota writer', async () => {
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    expect('registerConnectedServiceQuotaSnapshotPlain' in api).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('preserves status, retry-after, and cause for failed plaintext quota reads', async () => {
    const cause = {
      response: {
        status: 429,
        headers: { 'retry-after-ms': '1500' },
        data: { error: 'rate_limited' },
      },
    };
    mockGet.mockRejectedValue(cause);

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect((api as any).getConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 1_500,
      cause,
    });
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect((logger.debug as any).mock.calls[0]?.[0]).toContain('temporarily unavailable');
    expect((logger.debug as any).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect((logger.debug as any).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'rate_limited',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 1_500,
      },
    });
  });

  it('posts plaintext provider account usage snapshots to the canonical v3 endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
      providerId: 'codex',
      accountSubjectId: 'acct_123',
      subjectKind: 'account',
      quotaScope: 'account',
    };
    const snapshot: ProviderAccountUsageSnapshotV1 = {
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'acct_123' },
      observedAtMs: 1,
      fetchedAtMs: 1,
      staleAfterMs: 300_000,
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
      recoveryCredits: canonicalRecoveryCredits,
      meters: [],
    };

    const register = (api as {
      registerProviderAccountUsageSnapshotPlain?: (params: {
        recordId: string;
        content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
        metadata: {
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          materialFingerprint?: string;
        };
      }) => Promise<void>;
    }).registerProviderAccountUsageSnapshotPlain;
    expect(register).toEqual(expect.any(Function));
    await register!.call(api, {
      recordId: snapshot.recordId,
      content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'usage:1' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`),
      {
        content: {
          t: 'plain',
          v: {
            ...snapshot,
            recoveryCredits: predecessorRecoveryCredits,
          },
        },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'usage:1' },
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('posts plaintext provider account usage snapshots with source context to the canonical v3 endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
      providerId: 'codex',
      accountSubjectId: 'acct_123',
      subjectKind: 'account',
      quotaScope: 'account',
    };
    const snapshot: ProviderAccountUsageSnapshotV1 = {
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'acct_123' },
      observedAtMs: 1,
      fetchedAtMs: 1,
      staleAfterMs: 300_000,
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
      recoveryCredits: canonicalRecoveryCredits,
      meters: [],
    };

    const register = (api as {
      registerProviderAccountUsageSnapshotPlain?: (params: {
        recordId: string;
        source?: {
          serviceId: string;
          profileId: string;
          bindingKind: 'profile' | 'group_member';
          groupId?: string;
          groupGeneration?: number;
        };
        content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
        metadata: {
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          materialFingerprint?: string;
        };
      }) => Promise<void>;
    }).registerProviderAccountUsageSnapshotPlain;
    expect(register).toEqual(expect.any(Function));
    await register!.call(api, {
      recordId: snapshot.recordId,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
      content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'usage:1' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`),
      expect.objectContaining({
        content: {
          t: 'plain',
          v: {
            ...snapshot,
            recoveryCredits: predecessorRecoveryCredits,
          },
        },
        source: {
          serviceId: 'openai-codex',
          profileId: 'work',
          bindingKind: 'profile',
        },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('posts explicit group-member source context with provider account usage snapshots', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
      providerId: 'codex',
      accountSubjectId: 'acct_123',
      subjectKind: 'account',
      quotaScope: 'account',
    };
    const snapshot: ProviderAccountUsageSnapshotV1 = {
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'acct_123' },
      observedAtMs: 1,
      fetchedAtMs: 1,
      staleAfterMs: 300_000,
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
      meters: [],
    };

    const register = (api as {
      registerProviderAccountUsageSnapshotPlain?: (params: {
        recordId: string;
        source?: {
          serviceId: string;
          profileId: string;
          bindingKind: 'profile' | 'group_member';
          groupId?: string;
          groupGeneration?: number;
        };
        content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
        metadata: {
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          materialFingerprint?: string;
        };
      }) => Promise<void>;
    }).registerProviderAccountUsageSnapshotPlain;
    expect(register).toEqual(expect.any(Function));
    await register!.call(api, {
      recordId: snapshot.recordId,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      },
      content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'usage:group' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`),
      expect.objectContaining({
        content: { t: 'plain', v: snapshot },
        source: {
          serviceId: 'openai-codex',
          profileId: 'work',
          bindingKind: 'group_member',
          groupId: 'team',
          groupGeneration: 4,
        },
      }),
      expect.any(Object),
    );
  });

  it('posts explicit group-member source context with sealed provider account usage snapshots', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
      providerId: 'codex',
      accountSubjectId: 'acct_123',
      subjectKind: 'account',
      quotaScope: 'account',
    };
    const recordId = buildProviderAccountUsageRecordId(recordKey);

    const register = (api as {
      registerProviderAccountUsageSnapshotSealed?: (params: {
        recordId: string;
        recordKey: ProviderAccountUsageRecordKeyV1;
        source?: {
          serviceId: string;
          profileId: string;
          bindingKind: 'profile' | 'group_member';
          groupId?: string;
          groupGeneration?: number;
        };
        sealed: { format: 'account_scoped_v1'; ciphertext: string };
        metadata: {
          fetchedAt: number;
          staleAfterMs: number;
          status: 'ok' | 'unavailable' | 'estimated' | 'error';
          materialFingerprint?: string;
        };
      }) => Promise<void>;
    }).registerProviderAccountUsageSnapshotSealed;
    expect(register).toEqual(expect.any(Function));
    await register!.call(api, {
      recordId,
      recordKey,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      },
      sealed: { format: 'account_scoped_v1', ciphertext: 'sealed-group-member' },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'usage:group:sealed' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/v2/connect/provider-account-usage/${encodeURIComponent(recordId)}`),
      expect.objectContaining({
        recordKey,
        sealed: { format: 'account_scoped_v1', ciphertext: 'sealed-group-member' },
        source: {
          serviceId: 'openai-codex',
          profileId: 'work',
          bindingKind: 'group_member',
          groupId: 'team',
          groupGeneration: 4,
        },
      }),
      expect.any(Object),
    );
  });

  it('gets plaintext provider account usage snapshots from the canonical v3 endpoint', async () => {
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
      providerId: 'codex',
      accountSubjectId: 'acct_123',
      subjectKind: 'account',
      quotaScope: 'account',
    };
    const snapshot: ProviderAccountUsageSnapshotV1 = {
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'acct_123' },
      observedAtMs: 1,
      fetchedAtMs: 1,
      staleAfterMs: 300_000,
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
      meters: [],
    };
    const predecessorSnapshot = {
      ...snapshot,
      recoveryCredits: predecessorRecoveryCredits,
    };
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        content: { t: 'plain', v: predecessorSnapshot },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: 2 },
        sources: [{
          serviceId: 'openai-codex',
          profileId: 'work',
          bindingKind: 'group_member',
          groupId: 'team',
          groupGeneration: 4,
        }],
      },
    });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const getSnapshot = (api as {
      getProviderAccountUsageSnapshotPlain?: (params: { recordId: string }) => Promise<{
        content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
        metadata: { fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error'; refreshRequestedAt?: number };
        sources: readonly [{
          serviceId: string;
          profileId: string;
          bindingKind: 'profile' | 'group_member';
          groupId?: string;
          groupGeneration?: number;
        }];
      } | null>;
    }).getProviderAccountUsageSnapshotPlain;
    expect(getSnapshot).toEqual(expect.any(Function));
    await expect(getSnapshot!.call(api, { recordId: snapshot.recordId })).resolves.toEqual({
      content: {
        t: 'plain',
        v: {
          ...snapshot,
          recoveryCredits: canonicalRecoveryCredits,
        },
      },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: 2 },
      sources: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      }],
    });
  });

  it('gets sealed provider account usage snapshots with connected-service sources from the canonical v2 endpoint', async () => {
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
      providerId: 'codex',
      accountSubjectId: 'acct_123',
      subjectKind: 'account',
      quotaScope: 'account',
    };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'sealed-payload' },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: 2 },
        sources: [{
          serviceId: 'openai-codex',
          profileId: 'work',
          bindingKind: 'group_member',
          groupId: 'team',
          groupGeneration: 4,
        }],
      },
    });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const getSnapshot = (api as {
      getProviderAccountUsageSnapshotSealed?: (params: { recordId: string }) => Promise<{
        sealed: { format: 'account_scoped_v1'; ciphertext: string };
        metadata: { fetchedAt: number; staleAfterMs: number; status: 'ok' | 'unavailable' | 'estimated' | 'error'; refreshRequestedAt?: number };
        sources: readonly [{
          serviceId: string;
          profileId: string;
          bindingKind: 'profile' | 'group_member';
          groupId?: string;
          groupGeneration?: number;
        }];
      } | null>;
    }).getProviderAccountUsageSnapshotSealed;
    expect(getSnapshot).toEqual(expect.any(Function));
    await expect(getSnapshot!.call(api, { recordId })).resolves.toEqual({
      sealed: { format: 'account_scoped_v1', ciphertext: 'sealed-payload' },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: 2 },
      sources: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      }],
    });
  });
});
