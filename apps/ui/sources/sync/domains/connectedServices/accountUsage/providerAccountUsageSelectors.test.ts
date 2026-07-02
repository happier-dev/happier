import { describe, expect, it } from 'vitest';

import {
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
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
        aliases: [
            {
                kind: 'connectedServiceProfile',
                providerId: recordKey.providerId,
                serviceId: 'openai-codex',
                profileId: 'work',
                accountSubjectId: recordKey.accountSubjectId,
            },
            {
                kind: 'nativeCli',
                providerId: recordKey.providerId,
                localCredentialRef: 'codex-home',
                accountSubjectId: recordKey.accountSubjectId,
            },
        ],
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

async function loadSelectors() {
    try {
        return await import('./providerAccountUsageSelectors');
    } catch (error) {
        expect.fail(`canonical provider account usage selectors are missing: ${String(error)}`);
    }
}

describe('provider account usage selectors', () => {
    it('projects canonical usage to a connected-service alias without creating a second store shape', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot();

        const projected = selectors.projectProviderAccountUsageSnapshotForConnectedServiceAlias({
            snapshotsByRecordId: {
                [snapshot.recordId]: snapshot,
            },
            serviceId: 'openai-codex',
            profileId: 'work',
        });

        expect(projected?.serviceId).toBe('openai-codex');
        expect(projected?.profileId).toBe('work');
        expect(projected?.meters[0]?.meterId).toBe('weekly');
        expect(projected?.activeAccountId).toBe('acct_stable');
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

    it('does not manufacture a percentage for unknown or unavailable usage', async () => {
        const selectors = await loadSelectors();
        const empty = makeSnapshot({
            state: 'loaded_empty',
            source: 'unknown',
            confidence: 'unknown',
            meters: [],
            diagnostics: [{ kind: 'unavailable', code: 'no_usage_source' }],
        });

        const viewModel = selectors.computeProviderAccountUsageGaugeViewModel({
            snapshot: empty,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter: {
                remaining: ({ percent }: { percent: string }) => `${percent} left`,
                remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) => `${percent} left in ${reset}`,
                used: ({ used, limit }: { used: string; limit: string }) => `${used}/${limit}`,
                durationNow: () => 'now',
                durationDaysHours: ({ days, hours }: { days: number; hours: number }) => `${days}d ${hours}h`,
                durationHoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) => `${hours}h ${minutes}m`,
                durationHours: ({ hours }: { hours: number }) => `${hours}h`,
                durationMinutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
            },
        });

        expect(viewModel).toBeNull();
    });

    it('produces a gauge view-model for native usage without a connected-service binding', async () => {
        const selectors = await loadSelectors();
        const nativeSnapshot = makeSnapshot({
            recordKey: {
                providerId: 'codex',
                accountSubjectId: 'native_subject',
                subjectKind: 'account',
                quotaScope: 'account',
            },
            accountSubject: { kind: 'providerSubject', id: 'native_subject' },
            aliases: [{
                kind: 'nativeCli',
                providerId: 'codex',
                localCredentialRef: 'codex-home',
                accountSubjectId: 'native_subject',
            }],
        });

        const viewModel = selectors.computeProviderAccountUsageGaugeViewModel({
            snapshot: nativeSnapshot,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter: {
                remaining: ({ percent }: { percent: string }) => `${percent} left`,
                remainingWithReset: ({ percent, reset }: { percent: string; reset: string }) => `${percent} left in ${reset}`,
                used: ({ used, limit }: { used: string; limit: string }) => `${used}/${limit}`,
                durationNow: () => 'now',
                durationDaysHours: ({ days, hours }: { days: number; hours: number }) => `${days}d ${hours}h`,
                durationHoursMinutes: ({ hours, minutes }: { hours: number; minutes: number }) => `${hours}h ${minutes}m`,
                durationHours: ({ hours }: { hours: number }) => `${hours}h`,
                durationMinutes: ({ minutes }: { minutes: number }) => `${minutes}m`,
            },
        });

        expect(viewModel).not.toBeNull();
        expect(viewModel?.remainingPct).toBe(20);
        // Native-only usage must still project a connected-service alias map entry by
        // canonical alias, but the gauge itself must not require a connected service.
        const projectedForMissingAlias = selectors.projectProviderAccountUsageSnapshotForConnectedServiceAlias({
            snapshotsByRecordId: { [nativeSnapshot.recordId]: nativeSnapshot },
            serviceId: 'openai-codex',
            profileId: 'work',
        });
        expect(projectedForMissingAlias).toBeNull();
    });

    it('uses canonical connected-service profile keys for alias projections', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot({
            aliases: [{
                kind: 'connectedServiceProfile',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'team:account',
                accountSubjectId: 'acct_stable',
            }],
        });

        const projectedByKey = selectors.selectProviderAccountUsageSnapshotsByAlias({
            snapshotsByRecordId: {
                [snapshot.recordId]: snapshot,
            },
            aliases: [{
                serviceId: 'openai-codex',
                profileId: 'team:account',
            }],
        });

        expect(projectedByKey['openai-codex/team%3Aaccount']?.activeAccountId).toBe('acct_stable');
    });

    it('projects group-member aliases through member profiles without creating group-owned usage', async () => {
        const selectors = await loadSelectors();
        const snapshot = makeSnapshot({
            aliases: [{
                kind: 'connectedServiceGroupMember',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'backup',
                groupId: 'primary',
                accountSubjectId: 'acct_stable',
            }],
        });

        const projected = selectors.projectProviderAccountUsageSnapshotForConnectedServiceAlias({
            snapshotsByRecordId: {
                [snapshot.recordId]: snapshot,
            },
            serviceId: 'openai-codex',
            profileId: 'backup',
        });

        expect(projected?.profileId).toBe('backup');
        expect(projected?.activeAccountId).toBe('acct_stable');
        expect(projected?.meters[0]?.meterId).toBe('weekly');

        const groupOwnedProjection = selectors.projectProviderAccountUsageSnapshotForConnectedServiceAlias({
            snapshotsByRecordId: {
                [snapshot.recordId]: snapshot,
            },
            serviceId: 'openai-codex',
            profileId: 'primary',
        });
        expect(groupOwnedProjection).toBeNull();
    });

    it('prefers a stable provider subject over an older provisional duplicate alias projection', async () => {
        const selectors = await loadSelectors();
        const provisional = makeSnapshot({
            recordKey: {
                providerId: 'codex',
                accountSubjectId: 'provisional_subject',
                subjectKind: 'unknown',
                quotaScope: 'account',
            },
            accountSubject: {
                kind: 'provisionalLocalSubject',
                id: 'provisional_subject',
                mergeKey: 'local:codex-home',
            },
            fetchedAtMs: 3_000,
            observedAtMs: 3_000,
            aliases: [{
                kind: 'connectedServiceProfile',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'work',
                accountSubjectId: 'provisional_subject',
            }],
            meters: [{
                meterId: 'old-weekly',
                label: 'Old weekly',
                used: 90,
                limit: 100,
                unit: 'requests',
                utilizationPct: null,
                remainingPct: 10,
                resetsAt: null,
                status: 'ok',
                confidence: 'estimated',
                details: { limitCategory: 'usage_limit' },
            }],
        });
        const stable = makeSnapshot({
            fetchedAtMs: 1_000,
            observedAtMs: 1_000,
            aliases: [{
                kind: 'connectedServiceProfile',
                providerId: 'codex',
                serviceId: 'openai-codex',
                profileId: 'work',
                accountSubjectId: 'acct_stable',
            }],
            meters: [{
                meterId: 'stable-weekly',
                label: 'Stable weekly',
                used: 30,
                limit: 100,
                unit: 'requests',
                utilizationPct: null,
                remainingPct: 70,
                resetsAt: null,
                status: 'ok',
                confidence: 'exact',
                details: { limitCategory: 'usage_limit' },
            }],
        });

        const projected = selectors.projectProviderAccountUsageSnapshotForConnectedServiceAlias({
            snapshotsByRecordId: {
                [provisional.recordId]: provisional,
                [stable.recordId]: stable,
            },
            serviceId: 'openai-codex',
            profileId: 'work',
        });

        expect(projected?.activeAccountId).toBe('acct_stable');
        expect(projected?.meters[0]?.meterId).toBe('stable-weekly');
    });
});
