import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { formatUsageCost } from '@happier-dev/protocol/usage/usageFormatting';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { ProviderConnectionUsagePresentation, ProviderUsageMeterPresentation } from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';

import { SessionModelSourceUsage } from './SessionModelSourceUsage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const credits: ProviderUsageMeterPresentation = {
    meterId: 'credits', label: 'Credits', unit: 'usd', currency: 'USD',
    amount: { kind: 'remainingOfLimit', remaining: 12.4, limit: 25 }, remainingPct: 49.6, tone: 'neutral', estimated: false,
};
const keySpend: ProviderUsageMeterPresentation = {
    meterId: 'spend', label: 'Spend', unit: 'usd', currency: 'USD',
    amount: { kind: 'used', used: 3.2 }, remainingPct: null, tone: 'neutral', estimated: false,
};

function presentation(overrides: Partial<ProviderConnectionUsagePresentation> = {}): ProviderConnectionUsagePresentation {
    return {
        groups: [{ scope: 'key', meters: [keySpend] }, { scope: 'account', meters: [credits] }],
        billingSlots: [], checked: true, fetchedAt: Date.UTC(2026, 9, 28, 14, 2), sourceErrors: [], connectionError: null, unsupported: false,
        ...overrides,
    };
}

async function renderFact(options: Readonly<{
    presentation?: ProviderConnectionUsagePresentation;
    supported?: boolean;
    refreshing?: boolean;
    failed?: boolean;
    approval?: boolean;
}> = {}) {
    const onOpenApproval = vi.fn();
    const onOpenConnection = vi.fn();
    const screen = await renderScreen(
        <SessionModelSourceUsage
            usage={{
                supported: options.supported ?? true,
                presentation: options.presentation ?? presentation(),
                refreshing: options.refreshing ?? false,
                failed: options.failed ?? false,
                pendingApproval: null,
            }}
            onOpenApproval={options.approval ? onOpenApproval : null}
            onOpenConnection={onOpenConnection}
        />,
    );
    return { screen, onOpenApproval, onOpenConnection };
}

describe('SessionModelSourceUsage', () => {
    it('reads the source as one balance, with its as-of time, and routes to the connection', async () => {
        const { screen, onOpenConnection } = await renderFact();
        const text = screen.getTextContent();
        expect(text).toContain(`${formatUsageCost(12.4, 'USD')} of ${formatUsageCost(25, 'USD')} left`);
        // The account balance is the fact; the key's spend is not repeated beside it.
        expect(text).not.toContain(formatUsageCost(3.2, 'USD'));
        expect(screen.findByTestId('model-picker-source-usage:as-of')).toBeTruthy();
        // The pane's own refresh is the one control that re-reads it.
        expect(screen.findByTestId('model-picker-source-usage:refresh')).toBeNull();
        await screen.pressByTestIdAsync('model-picker-source-usage:details');
        expect(onOpenConnection).toHaveBeenCalledOnce();
    });

    it('keeps one line whatever the figure: the bars live on the connection page', async () => {
        const capped = await renderFact();
        expect(capped.screen.findByTestId('model-picker-source-usage:meter')).toBeTruthy();
        expect(capped.screen.findByTestId('model-picker-source-usage:meter:bar')).toBeNull();
    });

    it.each([
        { kind: 'remaining' as const, remaining: 7 },
        { kind: 'remainingOfLimit' as const, remaining: 7, limit: 10 },
    ])('uses the key allowance ahead of spend when account billing is unbound: $kind', async amount => {
        const allowance = { ...credits, meterId: 'allowance', label: 'Allowance', amount };
        const { screen } = await renderFact({ presentation: presentation({
            groups: [{ scope: 'key', meters: [keySpend, { ...credits, amount: null }, allowance] }],
            billingSlots: [{ slotId: 'managementKey', title: null, keyUrl: null, bound: false }],
        }) });
        expect(screen.getTextContent()).toContain(formatUsageCost(7, 'USD'));
        expect(screen.getTextContent()).not.toContain(formatUsageCost(3.2, 'USD'));
    });

    it('uses account remaining ahead of account spend and a key allowance regardless of group order', async () => {
        const allowance = { ...credits, amount: { kind: 'remaining' as const, remaining: 7 } };
        const { screen } = await renderFact({ presentation: presentation({ groups: [
            { scope: 'account', meters: [keySpend, credits] },
            { scope: 'key', meters: [allowance] },
        ] }) });
        expect(screen.getTextContent()).toContain(formatUsageCost(12.4, 'USD'));
        expect(screen.getTextContent()).not.toContain(formatUsageCost(3.2, 'USD'));
        expect(screen.getTextContent()).not.toContain(formatUsageCost(7, 'USD'));
    });

    it('uses a known key allowance when the account amount is unknown', async () => {
        const allowance = { ...credits, amount: { kind: 'remaining' as const, remaining: 7 } };
        const { screen } = await renderFact({ presentation: presentation({ groups: [
            { scope: 'account', meters: [{ ...credits, amount: null }] },
            { scope: 'key', meters: [keySpend, allowance] },
        ] }) });
        expect(screen.getTextContent()).toContain(formatUsageCost(7, 'USD'));
        expect(screen.getTextContent()).not.toContain(formatUsageCost(3.2, 'USD'));
    });

    it('renders nothing for a source that reports no usage', async () => {
        const { screen } = await renderFact({ supported: false });
        expect(screen.findByTestId('model-picker-source-usage')).toBeNull();
    });

    it('keeps Details on the failure\'s own line when there is no figure', async () => {
        const failed = presentation({ groups: [], sourceErrors: [{
            sourceId: 'account-credits', scope: 'account', billingSlotId: null, lastGood: false,
            error: createProviderErrorV1('provider_endpoint_unreachable', {}),
        }] });
        const { screen } = await renderFact({ presentation: failed });
        const line = screen.findByTestId('model-picker-source-usage:line');
        expect(line?.findAll((node) => node.props?.testID === 'model-picker-source-usage:details').length).toBeGreaterThan(0);
        expect(line?.findAll((node) => node.props?.testID === 'provider-error:provider_endpoint_unreachable').length).toBeGreaterThan(0);
    });

    it('keeps the last figure beside a failed refresh, leaving the retry to the pane', async () => {
        const failed = presentation({ sourceErrors: [{
            sourceId: 'account-credits', scope: 'account', billingSlotId: null, lastGood: true,
            error: createProviderErrorV1('provider_endpoint_unreachable', {}),
        }] });
        const { screen } = await renderFact({ presentation: failed });
        expect(screen.getTextContent()).toContain(formatUsageCost(12.4, 'USD'));
        // One retry: the pane's refresh. The failure line adds no second one.
        expect(screen.findByTestId('provider-error-action:provider_endpoint_unreachable')).toBeNull();
    });

    it('shows the shared approval line while a refresh waits for approval', async () => {
        const { screen, onOpenApproval } = await renderFact({ refreshing: true, approval: true });
        await screen.pressByTestIdAsync('model-picker-source-usage:approval.open');
        expect(onOpenApproval).toHaveBeenCalledOnce();
    });
});
