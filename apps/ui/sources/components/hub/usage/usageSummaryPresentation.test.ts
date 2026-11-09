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
});
