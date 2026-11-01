import { describe, expect, it } from 'vitest';

import { projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1, type ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from './fromConnectedServiceQuotaObservation';

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
  it('separates Claude quota contexts for the same user while sharing observations of the same context', () => {
    const observe = (profileId: string, providerOrganizationId: string) =>
      buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
        snapshot: {
          ...createSnapshot({ serviceId: 'claude-subscription', providerId: 'claude', activeAccountId: 'user-1', profileId }),
          providerOrganizationId,
        },
      });
    const team = observe('work', 'org-team');
    const personal = observe('personal', 'org-personal');
    expect(team.recordId).not.toBe(personal.recordId);
    expect(team.recordKey).toEqual({ providerId: 'claude', accountSubjectId: 'user-1',
      subjectKind: 'account', quotaScope: 'organization', quotaScopeId: 'org-team' });
    expect(observe('another-label', 'org-team').recordId).toBe(team.recordId);
    const projected = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
      snapshot: team,
      source: { serviceId: 'claude-subscription', profileId: 'work', bindingKind: 'profile' },
    });
    if (!projected) throw new Error('Expected the Claude usage observation to project to quota.');
    expect(buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({ snapshot: projected }).recordId)
      .toBe(team.recordId);
  });

  it('keeps unqualified Claude observations local until their organization is known', () => {
    const observe = (profileId: string) => buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: createSnapshot({ serviceId: 'claude-subscription', providerId: 'claude', activeAccountId: 'user-1', profileId }),
    });
    expect(observe('work').recordKey.subjectKind).toBe('unknown');
    expect(observe('work').recordId).not.toBe(observe('personal').recordId);
  });

  it('preserves recovery-credit presentation alongside the independent action fields', () => {
    const recoveryCreditDetails: NonNullable<ConnectedServiceQuotaSnapshotV1['recoveryCreditDetails']> = {
      grant: { remainingCount: 2, appliesToProviderLimitIds: ['weekly'], unavailableReason: 'cooldown' },
    };
    const recoveryCredits: NonNullable<ConnectedServiceQuotaSnapshotV1['recoveryCredits']> = {
      kind: 'usage_limit_resets', availableCount: 0,
      credits: [{ providerCreditId: 'grant', kind: 'usage_limit_reset', status: 'unknown' }],
    };
    const snapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: createSnapshot({ recoveryCredits, recoveryCreditDetails }),
    });
    expect(snapshot.recoveryCreditDetails).toEqual(recoveryCreditDetails);
    expect(snapshot.recoveryCredits).toEqual(recoveryCredits);
  });

  it('preserves subscription observation freshness separately from runtime usage evidence', () => {
    const subscription = { status: 'subscribed', renewal: 'off', observedAtMs: 500, staleAfterMs: 60_000,
      currentPeriodEndAtMs: 50_000 } as const;
    const snapshot = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: createSnapshot({ subscription }), observedAtMs: 1_234,
    });
    expect(snapshot.subscription).toEqual(subscription);
    expect(snapshot.fetchedAtMs).toBe(1_000);
    expect(snapshot.observedAtMs).toBe(1_234);
  });

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
