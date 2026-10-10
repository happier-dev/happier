import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { ItemList } from '@/components/ui/lists/ItemList';

import { AccountDetailUsageSectionView, AccountDetailSubscriptionSectionView, type AccountDetailUsageFacts } from './AccountDetailSections';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { projectIndexMeters } from '../index/ConnectedAccountIndexRow';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

const FACTS: AccountDetailUsageFacts = {
    meters: [
        { meterId: 'five_hour', label: '5-hour', remainingPct: 60, resetsAt: null, status: 'ok' },
        { meterId: 'seven_day', label: 'Weekly', remainingPct: 10, resetsAt: null, status: 'ok' },
    ],
    fetchedAt: 1_000,
    planLabel: null,
    subscription: null,
    recoveryCredits: null,
    loading: false,
    error: null,
    refreshing: false,
    refresh: null,
};

describe('AccountDetailUsageSectionView', () => {
    it('shows the quota failure reason beside retained usage and offers retry', async () => {
        const retry = vi.fn();
        const error = 'Couldn’t refresh usage. (HTTP 429) Try again after 12:30.';
        const screen = await renderScreen(<AccountDetailUsageSectionView
            facts={{ ...FACTS, error, refresh: retry }} signedOut={false} now={2_000}
        />);
        expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
        expect(screen.getTextContent()).toContain(error);
        const errorRow = screen.findByTestId('account-detail-usage:error');
        expect(errorRow).toBeTruthy();
        await screen.pressByTestIdAsync('account-detail-usage:error-action');
        expect(retry).toHaveBeenCalledOnce();
    });

    it('retains failure guidance but withholds quota retry until a signed-out account signs in', async () => {
        const error = 'Couldn’t refresh usage. (HTTP 401)';
        const screen = await renderScreen(<AccountDetailUsageSectionView
            facts={{ ...FACTS, error, refresh: vi.fn() }} signedOut now={2_000}
        />);
        expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
        expect(screen.getTextContent()).toContain(error);
        expect(screen.findByTestId('account-detail-usage:refresh')).toBeNull();
        expect(screen.findByTestId('account-detail-usage:error-action') === null).toBe(true);
    });

    it('filters empty account windows, preserves a pinned unavailable window, and keeps errors visible', async () => {
        const base = { used: null, limit: null, unit: 'unknown', utilizationPct: null, resetsAt: null, status: 'unavailable', details: {} } as const;
        const reported: ConnectedServiceQuotaMeterV1[] = [
            { ...base, meterId: 'full', label: 'Full', utilizationPct: 0, status: 'ok' },
            { ...base, meterId: 'empty', label: 'Empty', utilizationPct: 100, status: 'ok' },
            { ...base, meterId: 'placeholder', label: 'Placeholder' },
            { ...base, meterId: 'pinned', label: 'Pinned' },
        ];
        const rows = projectIndexMeters(reported, 2_000, ['pinned']);
        expect(rows.map((row) => row.meterId)).toEqual(['full', 'empty', 'pinned']);
        const screen = await renderScreen(<AccountDetailUsageSectionView facts={{ ...FACTS, meters: rows }} signedOut={false} now={2_000} pins={{ pinnedMeterIds: ['pinned'], onToggle: () => {} }} />);
        expect(screen.findByTestId('account-detail-usage:meter:placeholder')).toBeNull();
        expect(screen.findByTestId('account-detail-usage:pin:pinned')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Unavailable');
        await screen.update(<AccountDetailUsageSectionView facts={{ ...FACTS, meters: [], error: 'Couldn’t refresh usage.' }} signedOut={false} now={2_000} />);
        expect(screen.findByTestId('account-detail-usage:error')).toBeTruthy();
        await screen.update(<AccountDetailUsageSectionView facts={{ ...FACTS, meters: [] }} signedOut={false} now={2_000} />);
        expect(screen.getTextContent()).not.toContain('billed per use');
        expect(screen.getTextContent()).toContain('Unavailable');
    });

    it('keeps compact usage timestamp without repeating the page refresh control', async () => {
        const screen = await renderScreen(<ItemList><AccountDetailUsageSectionView facts={{ ...FACTS, fetchedAt: Date.now() - 1000, refresh: vi.fn() }} signedOut={false} now={Date.now()} compact /></ItemList>);
        expect(screen.findByTestId('account-detail-usage:refresh') === null).toBe(true);
        expect(screen.findByTestId('account-detail-usage:as-of')).not.toBeNull();
    });
    it('reads compact subscription as one status line without a separate section heading', async () => {
        const screen = await renderScreen(<AccountDetailSubscriptionSectionView serviceLabel="ChatGPT" planLabel="Pro" now={2_000} compact subscription={{ status: 'subscribed', renewal: 'off', observedAtMs: 1_000, staleAfterMs: 100_000, currentPeriodEndAtMs: 86_402_000 }} />);
        expect(screen.findByTestId('account-detail-subscription')).not.toBeNull();
        expect(screen.root.findAll((node) => node.props.title === 'Subscription')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('Not renewing');
    });
    it('pins a usage window from its row, showing which windows are pinned', async () => {
        const onTogglePinnedMeter = vi.fn();
        const screen = await renderScreen(
            <AccountDetailUsageSectionView
                facts={FACTS}
                signedOut={false}
                now={2_000}
                pins={{ pinnedMeterIds: ['seven_day'], onToggle: onTogglePinnedMeter }}
            />,
        );

        const pinOf = (meterId: string) => screen.root.findAll((node) => (
            node.props.testID === `account-detail-usage:pin:${meterId}` && typeof node.props.onPress === 'function'
        ))[0];
        expect(pinOf('seven_day')?.props.selected).toBe(true);
        expect(pinOf('five_hour')?.props.selected).toBe(false);

        screen.pressByTestId('account-detail-usage:pin:five_hour');
        expect(onTogglePinnedMeter).toHaveBeenCalledWith('five_hour');
    });

    it('offers no pins without a pin owner', async () => {
        const screen = await renderScreen(<AccountDetailUsageSectionView facts={FACTS} signedOut={false} now={2_000} />);
        expect(screen.findByTestId('account-detail-usage:pin:five_hour')).toBeNull();
        expect(screen.findByTestId('account-detail-usage:meter:five_hour')).toBeTruthy();
    });
});
