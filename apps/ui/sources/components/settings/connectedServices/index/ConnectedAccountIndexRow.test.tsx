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
        const screen = await renderScreen(<ConnectedAccountIndexUsageBlock testID="usage" usage={{ kind: 'meters', meters: projected }} />);
        expect(screen.getTextContent()).toContain(formatUsageCost(4.2, 'USD'));
        expect(screen.getTextContent()).toContain(`−${formatUsageCost(0.0123, 'CNY')}`);
        expect(screen.getTextContent()).toContain(formatUsageCost(0, 'USD'));
        expect(screen.getTextContent()).not.toContain('%');
    });
});

describe('account list row', () => {
    for (const compact of [false, true]) {
        it(`keeps a quota-backed list row${compact ? ' on a phone' : ''} free of per-row actions and opens the account from the row`, async () => {
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
            // Refresh lives in the header's "Refresh all", the cards and the account page (R138).
            expect(screen.findByTestId('account:refresh')).toBeFalsy();
            await screen.pressByTestIdAsync('account');
            expect(open).toHaveBeenCalledOnce();
            expect(refresh).not.toHaveBeenCalled();
        });
    }

    // The Overview mixes services on one sheet: a mode alone ("Subscription", "API key") would not say whose.
    it.each([
        [{ kind: 'subscription' } as const, null, 'Muse · Subscription'],
        [{ kind: 'apiKey', keySuffix: null } as const, null, 'Gemini · API key'],
        [{ kind: 'subscription' } as const, 'Muse Plus', 'Muse Plus'],
        // A service whose name already says it is a key is not followed by "API key" again.
        [{ kind: 'apiKey', keySuffix: null } as const, null, 'OpenAI API key'],
    ])('names the service beside an account mode no plan names (%o, plan %s)', async (accessMode, planLabel, expected) => {
        const facts: ConnectedAccountIndexFacts = {
            usage: { kind: 'none' }, planLabel, subscription: null, recoveryCredits: null,
            fetchedAt: null, staleSince: null, refreshing: false, refresh: null,
        };
        const service = expected.startsWith('Gemini') ? 'Gemini' : expected.startsWith('OpenAI') ? 'OpenAI API key' : 'Muse';
        const screen = await renderScreen(<ConnectedAccountIndexRowView
            testID="account" title="we-are@happier.dev" identityLabel={null} roles={[]} signedOut={null}
            legacyServiceId={null} accountId="a" star={null} onOpen={vi.fn()} accessMode={accessMode}
            serviceFact={service} facts={facts} now={2_000} compact={false}
        />);
        expect(screen.getTextContent()).toContain(expected);
        expect(screen.getTextContent()).not.toContain(`${expected} · `);
    });
});
