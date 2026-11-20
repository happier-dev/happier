import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fastify, { type FastifyInstance } from 'fastify';

import { ApiClient } from './api';
import { createDeferred } from '@/testkit/async/deferred';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import {
  type ConnectedServiceQuotaRecoveryCreditsV1,
} from '@happier-dev/protocol';

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

const credential = {
  token: 'happy-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32) },
} as const;

const plainCredential = { ...credential, encryption: null };

const encryptionPath = '/v1/account/encryption';
const quotaPath = '/v3/connect/openai-codex/profiles/work/quotas';

describe('ApiClient connected services quotas v3', () => {
  let app: FastifyInstance;
  let restoreAdapter: () => void;
  let requests: Array<{ method: string; url: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
    requests = [];
    app = fastify();
    app.addHook('onRequest', async ({ method, url }) => { requests.push({ method, url }); });
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
  });

  afterEach(async () => {
    restoreAdapter();
    await app.close();
  });

  it('reads persisted mode independently for callers without an admitted currentness observation', async () => {
    const reply = createDeferred<{ mode: 'plain'; updatedAt: number }>();
    app.get(encryptionPath, () => reply.promise);
    const api = await ApiClient.create(plainCredential);

    const first = api.getAccountEncryptionMode();
    const second = api.getAccountEncryptionMode();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    reply.resolve({ mode: 'plain', updatedAt: 1 });

    await expect(first).resolves.toBe('plain');
    await expect(second).resolves.toBe('plain');
    await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.method === 'GET' && request.url === encryptionPath)).toBe(true);
  });

  it('starts a fresh Account-mode lookup while an older lookup is in flight', async () => {
    const olderReply = createDeferred<{ mode: 'e2ee'; updatedAt: number }>();
    const freshReply = createDeferred<{ mode: 'plain'; updatedAt: number }>();
    const replies = [olderReply.promise, freshReply.promise];
    app.get(encryptionPath, () => replies.shift() ?? { mode: 'plain', updatedAt: 3 });
    const api = await ApiClient.create(plainCredential);

    const older = api.getAccountEncryptionMode();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const fresh = api.getAccountEncryptionMode({ refresh: true });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    freshReply.resolve({ mode: 'plain', updatedAt: 2 });
    await expect(fresh).resolves.toBe('plain');

    olderReply.resolve({ mode: 'e2ee', updatedAt: 1 });
    await expect(older).resolves.toBe('e2ee');

    await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.method === 'GET' && request.url === encryptionPath)).toBe(true);
  });

  it('returns persisted plain Account mode without feature discovery', async () => {
    app.get(encryptionPath, async () => ({ mode: 'plain', updatedAt: 1 }));
    const api = await ApiClient.create(plainCredential);
    await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
    expect(requests).toEqual([{ method: 'GET', url: encryptionPath }]);
  });

  it.each(['e2ee', 'unknown'] as const)(
    'does not require stored-content protocol admission for %s account mode',
    async (mode) => {
      app.get(encryptionPath, async () => ({ mode, updatedAt: 1 }));
      const api = await ApiClient.create(credential);
      await expect(api.getAccountEncryptionMode()).resolves.toBe(mode);
      expect(requests).toEqual([{ method: 'GET', url: encryptionPath }]);
    },
  );

  it('returns unknown when the account encryption mode probe fails with a non-404 status', async () => {
    app.get(encryptionPath, async (_request, reply) => reply.code(503).header('retry-after', '1').send());
    const api = await ApiClient.create(credential);
    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
    expect(requests).toEqual([{ method: 'GET', url: encryptionPath }]);
  });

  it('samples transient account encryption mode failures without error-labeled logs', async () => {
    app.get(encryptionPath, async (_request, reply) => reply.code(503).header('retry-after', '2')
      .send({ error: 'server_unavailable' }));
    const api = await ApiClient.create(credential);
    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
    expect(requests).toEqual([{ method: 'GET', url: encryptionPath }]);

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [label, details] = vi.mocked(logger.debug).mock.calls[0]!;
    expect(label).toContain('temporarily unavailable');
    expect(label).not.toContain('[ERROR]');
    expect(details).toMatchObject({
      classification: { kind: 'server_error', retryable: true, statusCode: 503 },
    });
  });

  it('gets plaintext quota snapshots from the v3 connected services quotas endpoint', async () => {
    app.get(quotaPath, async (request) => {
      expect(request.headers.authorization).toBe('Bearer ' + credential.token);
      return {
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
      };
    });
    const api = await ApiClient.create(credential);

    const result = await api.getConnectedServiceQuotaSnapshotPlain({ serviceId: 'openai-codex', profileId: 'work' });
    expect(result?.content.v.serviceId).toBe('openai-codex');
    expect(result?.content.v.recoveryCredits).toEqual(canonicalRecoveryCredits);
    expect(requests).toEqual([{ method: 'GET', url: quotaPath }]);
  });

  it('does not expose the retired plaintext connected-service quota writer', async () => {
    const api = await ApiClient.create(credential);

    expect('registerConnectedServiceQuotaSnapshotPlain' in api).toBe(false);
    expect(requests).toEqual([]);
  });

  it('preserves status, retry-after, and cause for failed plaintext quota reads', async () => {
    app.get(quotaPath, async (_request, reply) => reply.code(429).header('retry-after-ms', '1500')
      .send({ error: 'rate_limited' }));
    const api = await ApiClient.create(credential);

    await expect(api.getConnectedServiceQuotaSnapshotPlain({ serviceId: 'openai-codex', profileId: 'work' }))
      .rejects.toMatchObject({
        status: 429,
        retryAfterMs: 1_500,
        cause: { name: 'AxiosError', response: { status: 429, data: { error: 'rate_limited' } } },
      });
    expect(requests).toEqual([{ method: 'GET', url: quotaPath }]);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [label, details] = vi.mocked(logger.debug).mock.calls[0]!;
    expect(label).toContain('temporarily unavailable');
    expect(label).not.toContain('[ERROR]');
    expect(details).toMatchObject({
      classification: { kind: 'rate_limited', retryable: true, statusCode: 429, retryAfterMs: 1_500 },
    });
  });
});
