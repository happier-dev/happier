import { describe, expect, it } from 'vitest';

import {
    ConnectedServiceQuotaSnapshotV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    type ConnectedServiceQuotaSnapshotV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

function makeSnapshot(overrides: Partial<ProviderAccountUsageSnapshotV1> = {}): ProviderAccountUsageSnapshotV1 {
    const recordKey = overrides.recordKey ?? {
        providerId: 'codex',
        accountSubjectId: 'acct_stable',
        subjectKind: 'account',
        quotaScope: 'account',
    } satisfies ProviderAccountUsageSnapshotV1['recordKey'];
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: recordKey.providerId,
        accountSubject: {
            kind: 'providerSubject',
            id: recordKey.accountSubjectId,
        },
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 30_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Plus',
        accountLabel: 'Work',
        meters: [
            {
                meterId: 'weekly',
                label: 'Weekly',
                used: 80,
                limit: 100,
                unit: 'requests',
                utilizationPct: null,
                remainingPct: 20,
                resetsAt: null,
                status: 'ok',
                confidence: 'exact',
                details: { limitCategory: 'usage_limit' },
            },
        ],
        ...overrides,
    });
}

function makeQuotaSnapshot(overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1_000,
        staleAfterMs: 30_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [
            {
                meterId: 'weekly',
                label: 'Weekly',
                used: 88,
                limit: 100,
                unit: 'requests',
                utilizationPct: null,
                remainingPct: 12,
                resetsAt: null,
                status: 'ok',
                confidence: 'exact',
                details: { limitCategory: 'usage_limit' },
            },
        ],
        ...overrides,
    });
}

async function loadSelectors() {
    try {
        return await import('./providerAccountUsageSelectors');
    } catch (error) {
        expect.fail(`canonical provider account usage selectors are missing: ${String(error)}`);
    }
}

const formatter = {
    remaining: ({ percent }: { percent: string }) => `${percent} left`,
    remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) => `${percent} left in ${reset}`,
    used: ({ used, limit }: { used: string; limit: string }) => `${used}/${limit}`,
    durationNow: () => 'now',
    durationOutdated: () => 'outdated',
    durationDaysHours: ({ days, hours }: { days: number; hours: number }) => `${days}d ${hours}h`,
    durationHoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) => `${hours}h ${minutes}m`,
    durationHours: ({ hours }: { hours: number }) => `${hours}h`,
    durationMinutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
};

describe('provider account usage selectors', () => {
    it('removes connected-service alias projection helpers from the active selector surface', async () => {
        const selectors = await loadSelectors();

        expect('projectProviderAccountUsageSnapshotForConnectedServiceAlias' in selectors).toBe(false);
        expect('selectDisplayableProviderAccountUsageSnapshotForConnectedServiceQuota' in selectors).toBe(false);
        expect('selectProviderAccountUsageSnapshotsByAlias' in selectors).toBe(false);
    });

    it('suppresses native account-usage fallback for connected-service-bound sessions without a quota view', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot();

        expect(selectors.selectProviderUsageDisplaySource({
            providerId: null,
            metadataRecordIds: [snapshot.recordId],
            accountUsageSnapshotsByRecordId: {
                [snapshot.recordId]: snapshot,
            },
            connectedServiceProfileRef: { serviceId: 'openai-codex', profileId: 'work' },
            connectedServiceQuotaView: null,
        })).toBeNull();
    });

    it('prefers the connected-service quota view for connected-service-bound sessions', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot();
        const quotaView = makeQuotaSnapshot();

        expect(selectors.selectProviderUsageDisplaySource({
            providerId: 'openai-codex',
            metadataRecordIds: [snapshot.recordId],
            accountUsageSnapshotsByRecordId: {
                [snapshot.recordId]: snapshot,
            },
            connectedServiceProfileRef: { serviceId: 'openai-codex', profileId: 'work' },
            connectedServiceQuotaView: quotaView,
        })).toEqual({
            kind: 'connected_service_quota_view',
            snapshot: quotaView,
        });
    });

    it('selects native provider-account usage for non-connected sessions', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot();

        expect(selectors.selectProviderUsageDisplaySource({
            providerId: null,
            metadataRecordIds: [snapshot.recordId],
            accountUsageSnapshotsByRecordId: {
                [snapshot.recordId]: snapshot,
            },
            connectedServiceProfileRef: null,
            connectedServiceQuotaView: null,
        })).toEqual({
            kind: 'account_usage',
            snapshot,
        });
    });

    it('derives canonical loaded, empty, stale, and last-known-good states without clearing snapshots', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot();

        expect(selectors.resolveProviderAccountUsageSnapshotState({
            snapshot,
            loading: false,
            hadError: false,
            nowMs: 2_000,
        })).toBe('loaded_data');

        expect(selectors.resolveProviderAccountUsageSnapshotState({
            snapshot: makeSnapshot({ meters: [] }),
            loading: false,
            hadError: false,
            nowMs: 2_000,
        })).toBe('loaded_empty');

        expect(selectors.resolveProviderAccountUsageSnapshotState({
            snapshot,
            loading: false,
            hadError: false,
            nowMs: 32_001,
        })).toBe('stale_data');

        expect(selectors.resolveProviderAccountUsageSnapshotState({
            snapshot,
            loading: false,
            hadError: true,
            nowMs: 2_000,
        })).toBe('error_last_known_good');

        expect(selectors.resolveProviderAccountUsageSnapshotState({
            snapshot: null,
            loading: false,
            hadError: false,
            nowMs: 2_000,
        })).toBe('not_loaded');
    });

    it('produces a gauge view-model for native account usage', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot({
            recoveryCredits: {
                availableCount: 1,
                credits: [{
                    id: 'reset-credit-1',
                    kind: 'usage_limit_reset',
                    status: 'available',
                    expiresAtMs: 4_000,
                }],
            },
        });

        const viewModel = selectors.computeProviderAccountUsageGaugeViewModel({
            snapshot,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.remainingPct).toBe(20);
        expect(viewModel?.recoveryCreditSummary).toEqual({
            availableCount: 1,
            nextExpiresAtMs: 4_000,
            providerCreditId: 'reset-credit-1',
        });
    });

    it('normalizes provider-account usage record ids', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot();

        expect(selectors.normalizeProviderAccountUsageRecordIds([
            'bad',
            snapshot.recordId,
            snapshot.recordId,
            ` ${snapshot.recordId} `,
        ])).toEqual([snapshot.recordId]);
    });
});
