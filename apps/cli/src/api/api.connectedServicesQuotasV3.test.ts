import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import {
  buildProviderAccountUsageRecordId,
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

describe('ApiClient connected services quotas v3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const res = await (api as any).getConnectedServiceQuotaSnapshotPlain({ serviceId: 'openai-codex', profileId: 'work' });
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

  it('posts plaintext quota snapshots to the v3 connected services quotas endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await (api as any).registerConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: {
        t: 'plain',
        v: {
          v: 1,
          serviceId: 'openai-codex',
          profileId: 'work',
          fetchedAt: Date.now(),
          staleAfterMs: 300_000,
          planLabel: null,
          accountLabel: null,
          meters: [],
        },
      },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/quotas'),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify((logger as any).debug.mock.calls);
    expect(serializedLogs).not.toContain('staleAfterMs');
  });

  it('preserves status, retry-after, and cause for failed plaintext quota writes', async () => {
    const cause = {
      response: {
        status: 429,
        headers: { 'retry-after-ms': '1500' },
        data: { error: 'rate_limited' },
      },
    };
    mockPost.mockRejectedValue(cause);

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect((api as any).registerConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
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
    })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 1_500,
      cause,
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
      aliases: [{ kind: 'appServerNative', providerId: 'codex', accountSubjectId: 'acct_123' }],
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
        content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', materialFingerprint: 'usage:1' },
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
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
      aliases: [{ kind: 'appServerNative', providerId: 'codex', accountSubjectId: 'acct_123' }],
      observedAtMs: 1,
      fetchedAtMs: 1,
      staleAfterMs: 300_000,
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
      meters: [],
    };
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: 2 },
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
      } | null>;
    }).getProviderAccountUsageSnapshotPlain;
    expect(getSnapshot).toEqual(expect.any(Function));
    await expect(getSnapshot!.call(api, { recordId: snapshot.recordId })).resolves.toEqual({
      content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: 2 },
    });
  });
});
