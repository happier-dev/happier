import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ContextUsageState } from '../contextWarning';

import { AgentInputContextUsageBadge } from './AgentInputContextUsageBadge';

const tokenUsageRingRenderSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/sessions/usage', async () => {
    const ReactActual = await vi.importActual<typeof import('react')>('react');
    const ReactNative = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        TokenUsageRing: (props: { value?: string; valueTestID?: string }) => {
            tokenUsageRingRenderSpy(props);
            return ReactActual.createElement(ReactNative.Text, { testID: props.valueTestID }, props.value);
        },
    };
});

function contextUsageState(overrides: Partial<ContextUsageState> = {}): ContextUsageState {
    return {
        severity: 'warning',
        usedTokens: 82_000,
        contextWindowTokens: 100_000,
        warningWindowTokens: 90_000,
        usedRatio: 0.82,
        usedPercentage: 82,
        remainingWarningPercentage: 8.89,
        ...overrides,
    };
}

describe('AgentInputContextUsageBadge', () => {
    it('shows and fills the ring with remaining context', async () => {
        tokenUsageRingRenderSpy.mockClear();
        const screen = await renderScreen(<AgentInputContextUsageBadge state={contextUsageState()} />);
        expect(screen.findByTestId('agent-input-context-usage-value')?.props.children).toBe('18');
        expect(tokenUsageRingRenderSpy).toHaveBeenCalledWith(expect.objectContaining({ used: 18_000, limit: 100_000 }));
    });
    it('refreshes providers on every press while keeping the context details reachable', async () => {
        const refresh = vi.fn();
        const screen = await renderScreen(<AgentInputContextUsageBadge state={contextUsageState()} onRefresh={refresh} />);
        act(() => { screen.findByTestId('agent-input-context-usage-badge')?.props.onPress(); });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('agent-input-context-usage-popover')).toBeTruthy();
        act(() => { screen.findByTestId('agent-input-context-usage-badge')?.props.onPress(); });
        expect(refresh).toHaveBeenCalledTimes(2);
    });
    it('does not rerender the ring when parent rerenders with the same usage display data', async () => {
        tokenUsageRingRenderSpy.mockClear();
        const screen = await renderScreen(
            <AgentInputContextUsageBadge state={contextUsageState()} />,
        );

        await screen.update(
            <AgentInputContextUsageBadge state={contextUsageState()} />,
        );

        expect(tokenUsageRingRenderSpy).toHaveBeenCalledTimes(1);
        act(() => screen.tree.unmount());
    });
});
