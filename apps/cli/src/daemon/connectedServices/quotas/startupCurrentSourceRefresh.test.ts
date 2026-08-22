import { randomBytes } from 'node:crypto';

import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceQuotaSnapshotV1,
  type ConnectedServiceUsageSourceV1,
} from '@happier-dev/protocol';
import type { AgentAccountUsageSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceQuotaFetcher } from './types';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];

describe('ConnectedServiceQuotasCoordinator startup current-source refresh scheduling', () => {
  it('forces scheduled account-usage source repair even when the separate quota snapshot is fresh', async () => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-cold',
        providerEmail: 'cold@example.test',
      },
    });
    const freshSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      fetchedAt: now - 1_000,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'cold@example.test',
      meters: [],
    };
    const refreshedUsageSnapshot = {
      v: 1,
      recordKey: {
        providerId: 'openai-codex',
        accountSubjectId: 'acct-cold',
        subjectKind: 'account',
        quotaScope: 'account',
      },
      providerId: 'openai-codex',
      accountSubject: { kind: 'providerSubject', id: 'acct-cold' },
      observedAtMs: now,
      fetchedAtMs: now,
      staleAfterMs: freshSnapshot.staleAfterMs,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_empty',
      planLabel: freshSnapshot.planLabel,
      accountLabel: freshSnapshot.accountLabel,
      meters: [],
    } satisfies AgentAccountUsageSnapshot;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: freshSnapshot },
        metadata: {
          fetchedAt: freshSnapshot.fetchedAt,
          staleAfterMs: freshSnapshot.staleAfterMs,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } satisfies QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => refreshedUsageSnapshot),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes,
      discoveryEnabled: false,
    });
    const source = {
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      bindingKind: 'profile',
    } satisfies ConnectedServiceUsageSourceV1;

    coordinator.scheduleCurrentSourceRefresh([source]);
    await coordinator.tickOnce();

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });
});
