import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  type ConnectedServiceQuotaMeterV1,
  type ConnectedServiceQuotaSnapshotV1,
  type ProviderAccountUsageSnapshotV1,
  type ProviderAccountUsageStateV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { selectProviderUsageDisplaySnapshot } from './selectors';

function meter(overrides: Partial<ConnectedServiceQuotaMeterV1> = {}): ConnectedServiceQuotaMeterV1 {
  return {
    meterId: 'weekly',
    label: 'Weekly',
    used: 75,
    limit: 100,
    unit: 'count',
    utilizationPct: null,
    remainingPct: null,
    resetsAt: null,
    status: 'ok',
    details: { limitCategory: 'usage_limit' },
    ...overrides,
  };
}

function accountUsageSnapshot(params: Readonly<{
  providerId?: string;
  accountSubjectId?: string;
  providerOrganizationId?: string;
  state?: ProviderAccountUsageStateV1;
  fetchedAtMs?: number;
  staleAfterMs?: number;
  meters?: readonly ConnectedServiceQuotaMeterV1[];
}> = {}): ProviderAccountUsageSnapshotV1 {
  const providerId = params.providerId ?? 'codex';
  const accountSubjectId = params.accountSubjectId ?? 'provider-account-1';
  const recordKey = {
    providerId,
    accountSubjectId,
    subjectKind: 'account',
    quotaScope: params.providerOrganizationId ? 'organization' : 'account',
    ...(params.providerOrganizationId ? { quotaScopeId: params.providerOrganizationId } : {}),
  } as const;
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId,
    accountSubject: { kind: 'providerSubject', id: accountSubjectId },
    observedAtMs: params.fetchedAtMs ?? 1_000,
    fetchedAtMs: params.fetchedAtMs ?? 1_000,
    staleAfterMs: params.staleAfterMs ?? 60_000,
    source: 'providerHttp',
    confidence: 'confirmed',
    state: params.state ?? 'loaded_data',
    planLabel: 'Pro',
    accountLabel: 'Provider account',
    meters: [...(params.meters ?? [meter()])],
  });
}

function legacyQuotaSnapshot(): ConnectedServiceQuotaSnapshotV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    profileId: 'work',
    fetchedAt: 9_000,
    staleAfterMs: 60_000,
    planLabel: null,
    accountLabel: 'Legacy quota account',
    providerId: 'codex',
    meters: [meter({ meterId: 'legacy-weekly', used: 10, limit: 100 })],
  };
}

describe('selectProviderUsageDisplaySnapshot', () => {
  it('preserves organization scope and supplemental facts through the native account usage display projection', () => {
    const usage = {
      ...accountUsageSnapshot({ providerId: 'claude', providerOrganizationId: 'org-work' }),
      subscription: { status: 'none' as const, renewal: 'unknown' as const, observedAtMs: 1_000, staleAfterMs: 60_000 },
      recoveryCredits: { kind: 'usage_limit_resets' as const, availableCount: 0, credits: [
        { kind: 'usage_limit_reset' as const, status: 'unknown' as const, providerCreditId: 'saved' },
      ] },
      recoveryCreditDetails: { saved: {
        remainingCount: 2, appliesToProviderLimitIds: ['seven_day'], unavailableReason: 'paused' as const,
      } },
    };
    const source = selectProviderUsageDisplaySnapshot({
      providerId: 'claude', metadataRecordIds: [usage.recordId],
      accountUsageSnapshotsByRecordId: { [usage.recordId]: usage },
      connectedServiceProfileRef: null, connectedServiceQuotaView: null,
    });
    expect(source?.snapshot).toMatchObject({
      activeAccountId: usage.recordKey.accountSubjectId,
      providerOrganizationId: 'org-work',
      subscription: usage.subscription,
      recoveryCreditDetails: usage.recoveryCreditDetails,
    });
  });

  it('projects native account usage metadata into a non-connected provider usage display snapshot', () => {
    const usage = accountUsageSnapshot();

    const source = selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [usage.recordId],
      accountUsageSnapshotsByRecordId: { [usage.recordId]: usage },
      connectedServiceProfileRef: null,
      connectedServiceQuotaView: null,
    });

    expect(source).toEqual(expect.objectContaining({
      kind: 'account_usage',
      accountUsageSnapshot: usage,
      connectedServiceRefProvenance: 'published_quota_ref',
    }));
    expect(source?.snapshot).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: `acct:${usage.recordId}`,
      providerId: 'codex',
      accountLabel: 'Provider account',
    }));
  });

  it('keeps the connected-service quota view authoritative when a published quota ref also has native account usage metadata', () => {
    const usage = accountUsageSnapshot({
      meters: [meter({ meterId: 'native-weekly', used: 70, limit: 100 })],
    });
    const legacy = legacyQuotaSnapshot();

    const source = selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [usage.recordId],
      accountUsageSnapshotsByRecordId: { [usage.recordId]: usage },
      connectedServiceProfileRef: {
        serviceId: 'openai-codex',
        profileId: 'work',
        provenance: 'published_quota_ref',
      },
      connectedServiceQuotaView: legacy,
    });

    expect(source).toEqual(expect.objectContaining({
      kind: 'connected_service_quota_view',
      connectedServiceRefProvenance: 'published_quota_ref',
    }));
    expect(source?.snapshot).toEqual(expect.objectContaining({
      profileId: 'work',
      meters: [expect.objectContaining({ meterId: 'legacy-weekly' })],
    }));
  });

  it('does not project account usage through a connected-service alias without a connected-service quota view', () => {
    const usage = accountUsageSnapshot();

    const source = selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [usage.recordId],
      accountUsageSnapshotsByRecordId: { [usage.recordId]: usage },
      connectedServiceProfileRef: {
        serviceId: 'openai-codex',
        profileId: 'work',
        provenance: 'connected_binding_profile',
      },
      connectedServiceQuotaView: null,
    });

    expect(source).toBeNull();
  });

  it('suppresses connected-service quota display when credential health is not usable', () => {
    const usage = accountUsageSnapshot();
    const legacy = legacyQuotaSnapshot();

    const source = selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [usage.recordId],
      accountUsageSnapshotsByRecordId: { [usage.recordId]: usage },
      connectedServiceProfileRef: {
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialHealthStatus: 'needs_reauth',
        provenance: 'connected_binding_profile',
      },
      connectedServiceQuotaView: legacy,
    });

    expect(source).toBeNull();
  });

  it('ignores connected-service account usage records from other providers before falling back to the connected-service quota view', () => {
    const wrongProviderUsage = accountUsageSnapshot({
      providerId: 'claude',
      accountSubjectId: 'claude-account-1',
      meters: [meter({ meterId: 'claude-weekly', used: 95, limit: 100 })],
    });
    const legacy = legacyQuotaSnapshot();

    const source = selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [wrongProviderUsage.recordId],
      accountUsageSnapshotsByRecordId: { [wrongProviderUsage.recordId]: wrongProviderUsage },
      connectedServiceProfileRef: {
        serviceId: 'openai-codex',
        profileId: 'work',
        provenance: 'connected_binding_profile',
      },
      connectedServiceQuotaView: legacy,
    });

    expect(source).toEqual({
      kind: 'connected_service_quota_view',
      snapshot: legacy,
      connectedServiceRefProvenance: 'connected_binding_profile',
    });
  });

  it('keeps the connected-service quota view ahead of provider account usage when both exist for a connected binding', () => {
    const usage = accountUsageSnapshot({
      meters: [meter({ meterId: 'account-usage-weekly', used: 95, limit: 100 })],
    });
    const legacy = legacyQuotaSnapshot();

    const source = selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [usage.recordId],
      accountUsageSnapshotsByRecordId: { [usage.recordId]: usage },
      connectedServiceProfileRef: {
        serviceId: 'openai-codex',
        profileId: 'work',
        provenance: 'connected_binding_profile',
      },
      connectedServiceQuotaView: legacy,
    });

    expect(source).toEqual(expect.objectContaining({
      kind: 'connected_service_quota_view',
      connectedServiceRefProvenance: 'connected_binding_profile',
    }));
    expect(source?.snapshot).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'work',
      meters: [expect.objectContaining({ meterId: 'legacy-weekly' })],
    }));
  });

  it('ignores native account usage records from other providers before falling back to the connected-service quota view', () => {
    const wrongProviderUsage = accountUsageSnapshot({
      providerId: 'claude',
      accountSubjectId: 'claude-account-1',
      meters: [meter({ meterId: 'claude-weekly', used: 95, limit: 100 })],
    });
    const legacy = legacyQuotaSnapshot();

    const source = selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [wrongProviderUsage.recordId],
      accountUsageSnapshotsByRecordId: { [wrongProviderUsage.recordId]: wrongProviderUsage },
      connectedServiceProfileRef: null,
      connectedServiceQuotaView: legacy,
    });

    expect(source).toEqual({
      kind: 'connected_service_quota_view',
      snapshot: legacy,
      connectedServiceRefProvenance: null,
    });
  });

  it('keeps stale and error last-known-good account usage displayable without fabricating empty gauges', () => {
    const stale = accountUsageSnapshot({ state: 'stale_data', fetchedAtMs: 1 });
    const errorLastKnownGood = accountUsageSnapshot({ state: 'error_last_known_good', fetchedAtMs: 2 });
    const empty = accountUsageSnapshot({ state: 'loaded_empty', meters: [] });
    const errorEmpty = accountUsageSnapshot({ state: 'error_last_known_good', meters: [] });

    expect(selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [stale.recordId],
      accountUsageSnapshotsByRecordId: { [stale.recordId]: stale },
      connectedServiceProfileRef: null,
      connectedServiceQuotaView: null,
    })?.snapshot.fetchedAt).toBe(1);

    expect(selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [errorLastKnownGood.recordId],
      accountUsageSnapshotsByRecordId: { [errorLastKnownGood.recordId]: errorLastKnownGood },
      connectedServiceProfileRef: null,
      connectedServiceQuotaView: null,
    })?.snapshot.fetchedAt).toBe(2);

    expect(selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [empty.recordId],
      accountUsageSnapshotsByRecordId: { [empty.recordId]: empty },
      connectedServiceProfileRef: null,
      connectedServiceQuotaView: null,
    })).toBeNull();

    expect(selectProviderUsageDisplaySnapshot({
      providerId: 'codex',
      metadataRecordIds: [errorEmpty.recordId],
      accountUsageSnapshotsByRecordId: { [errorEmpty.recordId]: errorEmpty },
      connectedServiceProfileRef: null,
      connectedServiceQuotaView: null,
    })).toBeNull();
  });
});
