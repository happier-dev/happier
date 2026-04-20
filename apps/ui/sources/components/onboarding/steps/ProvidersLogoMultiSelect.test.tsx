import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    return Array.isArray(style)
        ? Object.assign({}, ...style.filter(Boolean))
        : (style as Record<string, unknown>);
}

describe('ProvidersLogoMultiSelect', () => {
    it('preserves explicit provider ids instead of filtering them through the built-in setup recommendation list', async () => {
        const onToggleProvider = vi.fn();
        const { ProvidersLogoMultiSelect } = await import('./ProvidersLogoMultiSelect');

        const screen = await renderScreen(
            <ProvidersLogoMultiSelect
                testID="providers-select"
                providerIds={['claude', 'customAcp', 'codex']}
                selectedProviderIds={['customAcp']}
                onToggleProvider={onToggleProvider}
            />,
        );

        const root = screen.findByTestId('providers-select');
        if (!root) {
            throw new Error('Expected providers-select root to render.');
        }
        expect(flattenStyle(root.props.style).gap).toBe(10);

        const claude = screen.findByTestId('providers-select-provider-claude');
        const codex = screen.findByTestId('providers-select-provider-codex');
        const customAcp = screen.findByTestId('providers-select-provider-customAcp');
        expect(claude).toBeTruthy();
        if (!codex) {
            throw new Error('Expected codex provider option to render.');
        }
        expect(customAcp).toBeTruthy();

        await pressTestInstanceAsync(codex, 'providers-select-provider-codex');
        expect(onToggleProvider).toHaveBeenCalledWith('codex');
    });
});
