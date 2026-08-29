import { describe, expect, it } from 'vitest';

import type {
  ConnectedServiceQuotaSnapshotV1,
  QualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';

import {
  buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation,
  buildProviderAccountUsageSnapshotFromQualifiedQuotaRow,
} from './fromConnectedServiceQuotaObservation';

function createSnapshot(
  overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {},
): ConnectedServiceQuotaSnapshotV1 {
  const snapshot: ConnectedServiceQuotaSnapshotV1 = {
    v: 1,
    serviceId: 'openai-codex',
    profileId: 'work',
    providerId: 'codex',
    activeAccountId: 'acct_live_codex',
    fetchedAt: 1_000,
    staleAfterMs: 300_000,
    source: 'in_band_provider_snapshot',
    confidence: 'exact',
    planLabel: null,
    accountLabel: null,
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: 10,
      remainingPct: 90,
      resetsAt: 10_000,
      status: 'ok',
      details: { limitCategory: 'usage_limit' },
    }],
    ...overrides,
  };
  return {
    ...snapshot,
    planLabel: snapshot.planLabel ?? null,
    accountLabel: snapshot.accountLabel ?? null,
  };
}

describe('buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation', () => {
  it('builds a canonical provider-account usage snapshot from exact runtime quota evidence', () => {
    const snapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: createSnapshot(),
      observedAtMs: 1_234,
    });

    expect(snapshot).toMatchObject({
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'acct_live_codex' },
      recordKey: {
        providerId: 'codex',
        accountSubjectId: 'acct_live_codex',
        subjectKind: 'account',
        quotaScope: 'account',
      },
      observedAtMs: 1_234,
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
    });
  });

  it('keeps source-of-truth writes provisional when the quota observation lacks stable account identity', () => {
    const snapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: createSnapshot({
        activeAccountId: undefined,
        profileId: 'native:abcdef0123456789abcdef0123456789abcdef0123456789',
      }),
    });

    expect(snapshot.accountSubject).toMatchObject({
      kind: 'provisionalLocalSubject',
      id: 'legacy-connected-service:openai-codex:native:abcdef0123456789abcdef0123456789abcdef0123456789',
      mergeKey: 'openai-codex:native:abcdef0123456789abcdef0123456789abcdef0123456789',
    });
    expect(snapshot.recordKey.subjectKind).toBe('unknown');
  });

  it('uses the credential provider account as stable identity when the quota observation omits it', () => {
    const snapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: createSnapshot({
        activeAccountId: undefined,
        profileId: 'work',
      }),
      sourceProviderAccountId: 'credential-provider-account',
    });

    expect(snapshot).toMatchObject({
      accountSubject: { kind: 'providerSubject', id: 'credential-provider-account' },
      recordKey: {
        providerId: 'codex',
        accountSubjectId: 'credential-provider-account',
        subjectKind: 'account',
        quotaScope: 'account',
      },
    });
  });
});

describe('buildProviderAccountUsageSnapshotFromQualifiedQuotaRow', () => {
  it('keeps an opened row provisional when its optional provider subject is absent', () => {
    const snapshot = buildProviderAccountUsageSnapshotFromQualifiedQuotaRow({
      ref: {
        service: { pluginId: 'acme.agent', localId: 'acme-account' },
        accountId: 'connected-account-1',
      },
      quota: {
        ...createSnapshot({ activeAccountId: undefined }),
        ref: {
          service: { pluginId: 'acme.agent', localId: 'acme-account' },
          accountId: 'connected-account-1',
        },
        serviceId: undefined,
        profileId: undefined,
      } as unknown as QualifiedConnectedAccountQuotaSnapshotV4,
    });

    expect(snapshot.accountSubject).toEqual({
      kind: 'provisionalLocalSubject',
      id: 'legacy-connected-service:acme.agent/acme-account:connected-account-1',
      mergeKey: 'acme.agent/acme-account:connected-account-1',
    });
    expect(snapshot.recordKey.subjectKind).toBe('unknown');
  });
});
