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

const catalogIconState = vi.hoisted(() => ({
    // Agents with a resolvable icon; anything else renders no logo asset.
    iconIds: new Set(['claude', 'codex', 'customAcp', 'opencode']),
}));
vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: (agentId: string) => (catalogIconState.iconIds.has(agentId) ? '<svg/>' : null),
    getAgentIconSource: () => null,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    return Array.isArray(style)
        ? Object.assign({}, ...style.filter(Boolean))
        : (style as Record<string, unknown>);
}

describe('AgentsLogoMultiSelect', () => {
    it('preserves explicit provider ids instead of filtering them through the built-in setup recommendation list', async () => {
        const onToggleAgent = vi.fn();
        const { AgentsLogoMultiSelect } = await import('./AgentsLogoMultiSelect');

        const screen = await renderScreen(
            <AgentsLogoMultiSelect
                testID="providers-select"
                agentIds={['claude', 'customAcp', 'codex']}
                selectedAgentIds={['customAcp']}
                onToggleAgent={onToggleAgent}
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
        expect(onToggleAgent).toHaveBeenCalledWith('codex');
    });

    it('renders detected providers as locked-selected tiles with a readiness dot', async () => {
        const onToggleAgent = vi.fn();
        const { AgentsLogoMultiSelect } = await import('./AgentsLogoMultiSelect');

        const screen = await renderScreen(
            <AgentsLogoMultiSelect
                testID="providers-select"
                agentIds={['claude', 'codex']}
                selectedAgentIds={[]}
                readyAgentIds={['claude']}
                onToggleAgent={onToggleAgent}
            />,
        );

        // Detected provider: readiness dot + selected presentation.
        expect(screen.findByTestId('providers-select-provider-claude-ready-dot')).toBeTruthy();
        expect(screen.findAllByTestId('providers-select-provider-codex-ready-dot')).toHaveLength(0);

        // Locked-selected: tapping a detected provider never toggles it off.
        const claude = screen.findByTestId('providers-select-provider-claude');
        if (!claude) throw new Error('Expected claude tile to render.');
        await pressTestInstanceAsync(claude, 'providers-select-provider-claude');
        expect(onToggleAgent).not.toHaveBeenCalled();

        // Undetected providers keep normal toggling.
        const codex = screen.findByTestId('providers-select-provider-codex');
        if (!codex) throw new Error('Expected codex tile to render.');
        await pressTestInstanceAsync(codex, 'providers-select-provider-codex');
        expect(onToggleAgent).toHaveBeenCalledWith('codex');
    });

    it('skips agents without a resolvable logo instead of rendering empty tiles', async () => {
        const { AgentsLogoMultiSelect } = await import('./AgentsLogoMultiSelect');

        const screen = await renderScreen(
            <AgentsLogoMultiSelect
                testID="providers-select"
                agentIds={['claude', 'coderabbit', 'deepsec', 'codex']}
                selectedAgentIds={[]}
                onToggleAgent={vi.fn()}
            />,
        );

        expect(screen.findByTestId('providers-select-provider-claude')).toBeTruthy();
        expect(screen.findByTestId('providers-select-provider-codex')).toBeTruthy();
        expect(screen.findAllByTestId('providers-select-provider-coderabbit')).toHaveLength(0);
        expect(screen.findAllByTestId('providers-select-provider-deepsec')).toHaveLength(0);
    });
});
