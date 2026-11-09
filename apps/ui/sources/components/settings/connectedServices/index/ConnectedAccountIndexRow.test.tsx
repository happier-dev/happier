import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { formatUsageCost } from '@/utils/format/usageNumbers';
import { ConnectedAccountIndexRowView, ConnectedAccountIndexUsageBlock, projectIndexMeters, type ConnectedAccountIndexFacts } from './ConnectedAccountIndexRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('account usage amounts', () => {
    it('renders uncapped usage and provider-denominated remaining balances without inventing a percentage', async () => {
        const base = {
            used: null, limit: null, utilizationPct: null, resetsAt: null, status: 'ok', unit: 'usd', details: {},
        } as const;
        const meters = [
            { ...base, meterId: 'spent', label: 'Today', used: 4.2, currency: 'USD' },
            { ...base, meterId: 'balance', label: 'Balance', remaining: -0.0123, currency: 'CNY', unit: 'unknown' },
            { ...base, meterId: 'zero', label: 'Measured zero', used: 0, currency: 'USD' },
        ] satisfies ConnectedServiceQuotaMeterV1[];
        const projected = projectIndexMeters(meters, 1_000);
        expect(projected.map(meter => meter.remainingPct)).toEqual([null, null, null]);
        const screen = await renderScreen(<ConnectedAccountIndexUsageBlock testID="usage" usage={{ kind: 'meters', meters: projected }} now={1_000} />);
        expect(screen.getTextContent()).toContain(formatUsageCost(4.2, 'USD'));
        expect(screen.getTextContent()).toContain(`−${formatUsageCost(0.0123, 'CNY')}`);
        expect(screen.getTextContent()).toContain(formatUsageCost(0, 'USD'));
        expect(screen.getTextContent()).not.toContain('%');
    });
});

describe('account list row actions', () => {
    for (const compact of [false, true]) {
        it(`offers the card's usage refresh on a quota-backed list row${compact ? ' on a phone' : ''} without opening the account`, async () => {
            const refresh = vi.fn();
            const open = vi.fn();
            const facts: ConnectedAccountIndexFacts = {
                usage: { kind: 'meters', meters: [{ meterId: 'five-hour', label: '5h', remainingPct: 60, resetsAt: null, status: 'ok' }] },
                planLabel: 'Max', subscription: null, recoveryCredits: null, fetchedAt: 1_000, staleSince: null, refreshing: false, refresh,
            };
            const screen = await renderScreen(<ConnectedAccountIndexRowView
                testID="account" title="work@example.test" identityLabel={null} roles={[]} signedOut={null}
                legacyServiceId={null} accountId="work" star={null} onOpen={open}
                facts={facts} now={2_000} compact={compact}
            />);
            await screen.pressByTestIdAsync('account:refresh');
            expect(refresh).toHaveBeenCalledOnce();
            expect(open).not.toHaveBeenCalled();
        });
    }
});
