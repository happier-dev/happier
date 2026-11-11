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
  it('retains the observed organization and user across scalar and qualified quota hydration', () => {
    const quota = { ...createSnapshot(), providerOrganizationId: 'observed-org' };
    const scalar = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({ snapshot: quota });
    const { serviceId: _serviceId, profileId: _profileId, ...quotaFields } = quota;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    const qualified = buildProviderAccountUsageSnapshotFromQualifiedQuotaRow({ ref, quota: { ...quotaFields, ref } });
    for (const snapshot of [scalar, qualified]) {
      expect(snapshot.recordKey).toMatchObject({ accountSubjectId: 'acct_live_codex', subjectKind: 'account', quotaScope: 'organization', quotaScopeId: 'observed-org' });
      expect(snapshot.accountSubject).toEqual({ kind: 'providerSubject', id: 'acct_live_codex' });
    }
  });

  it('preserves recovery-credit presentation through scalar and qualified quota conversion', () => {
    const recoveryCreditDetails = { grant: { remainingCount: 2, appliesToProviderLimitIds: ['weekly'], unavailableReason: 'cooldown' as const } };
    const quota = createSnapshot({ recoveryCreditDetails });
    expect(buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({ snapshot: quota }).recoveryCreditDetails).toEqual(recoveryCreditDetails);
    const { serviceId: _serviceId, profileId: _profileId, ...quotaFields } = quota;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    expect(buildProviderAccountUsageSnapshotFromQualifiedQuotaRow({ ref, quota: { ...quotaFields, ref } }).recoveryCreditDetails).toEqual(recoveryCreditDetails);
  });

  it('builds a canonical provider-account usage snapshot from exact runtime quota evidence', () => {
    const subscription = {
      status: 'subscribed' as const, renewal: 'off' as const,
      observedAtMs: 900, staleAfterMs: 60_000,
      currentPeriodEndAtMs: 1_800_000_000_000,
    };
    const snapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: createSnapshot({ subscription }),
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
      subscription,
    });
  });

  it('keeps an unknown allowance distinct from exhausted capacity', () => {
    const snapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: createSnapshot({
        confidence: 'unknown',
        meters: [{
          meterId: 'weekly', label: 'Weekly', used: null, limit: 100,
          utilizationPct: 100, remainingPct: 0, isExhausted: true,
          resetsAt: 10_000, status: 'ok', confidence: 'unknown', unit: 'unknown', details: {},
        }],
      }),
    });

    expect(snapshot.meters[0]).toMatchObject({
      used: null,
      limit: 100,
      utilizationPct: null,
      remainingPct: null,
      isExhausted: false,
      resetsAt: 10_000,
      confidence: 'unknown',
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
