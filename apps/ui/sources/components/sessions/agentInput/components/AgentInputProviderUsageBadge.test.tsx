import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tokenUsageRingRenderSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/usage', () => ({
    TokenUsageRing: (props: Record<string, unknown>) => {
        tokenUsageRingRenderSpy(props);
        return React.createElement('TokenUsageRing', props);
    },
}));

vi.mock('./AgentInputContentPopover', () => ({
    AgentInputContentPopover: (props: Record<string, unknown>) => React.createElement('AgentInputContentPopover', props),
}));

function buildViewModel(overrides: Partial<ConnectedServiceQuotaGaugeViewModel> = {}): ConnectedServiceQuotaGaugeViewModel {
    return {
        allMeterRows: [{
            detailRightLabel: '10 left',
            label: 'Daily',
            meterId: 'daily',
            remainingPct: 80,
            tone: 'neutral',
            usedLimitLabel: '20 / 100',
        }],
        badgeLabel: '80%',
        detailRightLabel: '20 / 100',
        recoveryCreditSummary: null,
        ringValueLabel: '80',
        tone: 'neutral',
        usedPct: 20,
        ...overrides,
    } as ConnectedServiceQuotaGaugeViewModel;
}

describe('AgentInputProviderUsageBadge', () => {
    afterEach(() => {
        tokenUsageRingRenderSpy.mockClear();
        standardCleanup();
    });

    it('skips ring rerenders for display-equivalent quota view models', async () => {
        const { AgentInputProviderUsageBadge } = await import('./AgentInputProviderUsageBadge');
        const screen = await renderScreen(
            <AgentInputProviderUsageBadge viewModel={buildViewModel()} />,
        );

        await screen.update(
            <AgentInputProviderUsageBadge viewModel={buildViewModel()} />,
        );

        expect(tokenUsageRingRenderSpy).toHaveBeenCalledTimes(1);
    });
});
