import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { ApiClient } from './api';
import {
  AccountStoredContentClientUpgradeRequiredError,
} from './clientCompatibility/accountStoredContentActivation';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import {
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  type ConnectedServiceQuotaRecoveryCreditsV1,
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

const currentRequiredAccountStoredContentSnapshot = {
  status: 'ready',
  features: {
    capabilities: {
      accountStoredContentCompatibility: {
        v: 1,
        minimumProtocolVersion: 2,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
      },
    },
  },
} as const;

describe('ApiClient connected services quotas v3', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });

  it('gets the account encryption mode from /v1/account/encryption', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);
    const getServerFeaturesSnapshot = vi
      .spyOn(api, 'getServerFeaturesSnapshot')
      .mockResolvedValue(currentRequiredAccountStoredContentSnapshot as never);

    const mode = await (api as any).getAccountEncryptionMode();
    expect(mode).toBe('plain');
    expect(getServerFeaturesSnapshot).toHaveBeenCalledWith({ refresh: true });
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
    const getServerFeaturesSnapshot = vi
      .spyOn(api, 'getServerFeaturesSnapshot')
      .mockResolvedValue(currentRequiredAccountStoredContentSnapshot as never);

    const first = (api as any).getAccountEncryptionMode();
    const second = (api as any).getAccountEncryptionMode();

    expect(mockGet).toHaveBeenCalledTimes(1);

    resolveMode?.({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    await expect(first).resolves.toBe('plain');
    await expect(second).resolves.toBe('plain');

    await expect((api as any).getAccountEncryptionMode()).resolves.toBe('plain');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(getServerFeaturesSnapshot).toHaveBeenCalledTimes(3);
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
    const getServerFeaturesSnapshot = vi
      .spyOn(api, 'getServerFeaturesSnapshot')
      .mockResolvedValue(currentRequiredAccountStoredContentSnapshot as never);

    const older = (api as any).getAccountEncryptionMode();
    const fresh = (api as any).getAccountEncryptionMode({ refresh: true });

    expect(mockGet).toHaveBeenCalledTimes(2);
    resolveFresh?.({ status: 200, data: { mode: 'plain', updatedAt: 2 } });
    await expect(fresh).resolves.toBe('plain');

    resolveOlder?.({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    await expect(older).resolves.toBe('e2ee');

    await expect((api as any).getAccountEncryptionMode()).resolves.toBe('plain');
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(getServerFeaturesSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: 'missing',
      snapshot: {
        status: 'ready',
        features: { capabilities: {} },
      },
      decision: 'missing',
    },
    {
      label: 'pre-v2',
      snapshot: {
        status: 'ready',
        features: {
          capabilities: {
            accountStoredContentCompatibility: {
              v: 1,
              minimumProtocolVersion: 1,
              currentProtocolVersion: 1,
              declarationTransport: 'http-header-and-socket-auth-v1',
            },
          },
        },
      },
      decision: 'server-too-old',
    },
  ])('rejects raw plain mode against a $label stored-content protocol snapshot', async ({
    snapshot,
    decision,
  }) => {
    mockGet.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);
    const getServerFeaturesSnapshot = vi
      .spyOn(api, 'getServerFeaturesSnapshot')
      .mockResolvedValue(snapshot as never);
    const downstreamPlaintextEffect = vi.fn();

    await expect(
      api.getAccountEncryptionMode().then(downstreamPlaintextEffect),
    ).rejects.toMatchObject({
      name: AccountStoredContentClientUpgradeRequiredError.name,
      code: 'client-upgrade-required',
      retryable: false,
      decision,
    });
    expect(getServerFeaturesSnapshot).toHaveBeenCalledWith({ refresh: true });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(downstreamPlaintextEffect).not.toHaveBeenCalled();
  });

  it.each(['e2ee', 'unknown'] as const)(
    'does not require stored-content protocol admission for %s account mode',
    async (mode) => {
      mockGet.mockResolvedValue({ status: 200, data: { mode, updatedAt: 1 } });
      const api = await ApiClient.create({
        token: 'happy-token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
      } as any);
      const getServerFeaturesSnapshot = vi.spyOn(api, 'getServerFeaturesSnapshot');

      await expect(api.getAccountEncryptionMode()).resolves.toBe(mode);
      expect(getServerFeaturesSnapshot).not.toHaveBeenCalled();
    },
  );

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

});
