import { describe, expect, it } from 'vitest';
import type { ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

import { buildUsageSummary, buildUsageSummaryCache } from './usageSummaryPresentation';
import { groupUsageByProvider } from './usageByProvider';

const amount = { amount: { kind: 'used', used: 4.2 }, unit: 'usd', currency: 'USD' } as const;
const summary = {
    key: 'service/account', service: { pluginId: 'test.provider', localId: 'service' },
    legacyServiceId: null, serviceLabel: 'Service', serviceGroupKey: 'test.provider/service',
    accountLabel: 'Account', accountEmail: null, accountId: 'account', profileLabel: null, profileId: 'account',
    planLabel: null, primaryMeter: null, fetchedAt: 1_000, recoveryCredits: null,
    meters: [{ meterId: 'spent', label: 'Today', remainingPct: null, utilizationPct: null,
        resetsAt: null, status: 'estimated', reportedAmount: amount }],
} satisfies ConnectedServiceQuotaSummary;

describe('usage amounts across saved summaries and provider grouping', () => {
    it('retains the last observed currency amount and its time through cold restoration and grouping', () => {
        const saved = buildUsageSummaryCache([summary]);
        expect(saved?.entries[0]?.meters[0]).toMatchObject({ reportedAmount: amount, status: 'estimated' });
        const restored = buildUsageSummary({ live: null, saved, accountsWithoutUsage: [] });
        expect(restored.source).toBe('lastKnown');
        expect(restored.asOf).toBe(1_000);
        expect(groupUsageByProvider(restored.accounts)[0]?.accounts[0]?.windows[0])
            .toMatchObject({ remainingPct: null, reportedAmount: amount, status: 'estimated' });
    });

    it('keeps when the earliest shown read goes stale, through cold restoration', () => {
        const fresh = { ...summary, key: 'service/fresh', fetchedAt: 5_000, staleAfterMs: 10_000 };
        const old = { ...summary, key: 'service/old', fetchedAt: 1_000, staleAfterMs: 2_000 };
        const live = buildUsageSummary({ live: buildUsageSummaryCache([fresh, old]), saved: null, accountsWithoutUsage: [] });
        expect(live.staleAt).toBe(3_000);
        const restored = buildUsageSummary({ live: null, saved: buildUsageSummaryCache([fresh, old]), accountsWithoutUsage: [] });
        expect(restored.staleAt).toBe(3_000);
        // No freshness window from the producer: the page never claims staleness it cannot know.
        expect(buildUsageSummary({ live: buildUsageSummaryCache([summary]), saved: null, accountsWithoutUsage: [] }).staleAt).toBeNull();
    });

    it('dates only the readings it shows: an account that reports no usage does not set as-of or staleness', () => {
        const shown = { ...summary, key: 'service/shown', fetchedAt: 9_000, staleAfterMs: 10_000 };
        const silent = { ...summary, key: 'service/silent', fetchedAt: 1_000, staleAfterMs: 2_000, meters: [] };
        const usage = buildUsageSummary({ live: buildUsageSummaryCache([shown, silent]), saved: null, accountsWithoutUsage: [] });
        expect(usage.asOf).toBe(9_000);
        expect(usage.staleAt).toBe(19_000);
        expect(buildUsageSummary({ live: buildUsageSummaryCache([silent]), saved: null, accountsWithoutUsage: [] }).asOf).toBeNull();
    });

    it('dates the rail by its newest shown reading; meterless or undated entries neither date nor blank it (review J-B50)', () => {
        const at = (minute: number) => Date.UTC(2026, 10, 25, 12, minute);
        const first = { ...summary, key: 'service/first', fetchedAt: at(0), staleAfterMs: 3_600_000 };
        const second = { ...summary, key: 'service/second', fetchedAt: at(4), staleAfterMs: 3_600_000 };
        const live = buildUsageSummary({ live: buildUsageSummaryCache([first, second]), saved: null, accountsWithoutUsage: [] });
        expect(live.shownReadAt).toBe(at(4));
        // A saved meterless entry without a read time (the cache schema admits null).
        const saved = buildUsageSummaryCache([first, second])!;
        const undated = { ...saved, entries: [...saved.entries, { key: 'service/undated', fetchedAt: null, serviceLabel: 'Service', profileLabel: null, planLabel: null, meters: [] }] };
        const restored = buildUsageSummary({ live: null, saved: undated, accountsWithoutUsage: [] });
        expect(restored.shownReadAt).toBe(at(4));
        // Credentials keeps its oldest-reading bound.
        expect(restored.asOf).toBe(at(0));
        expect(buildUsageSummary({ live: null, saved: { v: 1, entries: [undated.entries[2]!] }, accountsWithoutUsage: [] }).shownReadAt).toBeNull();
    });
});
