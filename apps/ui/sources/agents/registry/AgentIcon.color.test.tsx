import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-svg', () => ({
    SvgXml: (props: any) => React.createElement('SvgXml', props),
}));

vi.mock('@/components/ui/media/SafeExpoImage', () => ({
    SafeExpoImage: (props: any) => React.createElement('SafeExpoImage', props),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: {
                    primary: '#101010',
                },
            },
        },
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSource: (agentId: string) => agentId === 'image' ? { uri: 'agent.png' } : null,
    getAgentIconSvgXml: (agentId: string) => agentId === 'svg'
        ? '<svg fill="#111111" stroke="#222222"><path fill="#333333" stroke="none" /></svg>'
        : null,
    getAgentIconTintColor: () => '#444444',
}));

describe('AgentIcon color override', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('applies the explicit color to svg fills and strokes', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <AgentIcon
                agentId="svg"
                size={16}
                color="#777777"
            />,
        );

        const svg = screen.findAllByType('SvgXml' as never)[0];
        expect(svg?.props.xml).toContain('fill="#777777"');
        expect(svg?.props.xml).toContain('stroke="#777777"');
        expect(svg?.props.xml).toContain('stroke="none"');
    });

    it('uses the explicit color as the image tint', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <AgentIcon
                agentId="image"
                size={16}
                color="#777777"
            />,
        );

        expect(screen.findAllByType('SafeExpoImage' as never)[0]?.props.tintColor).toBe('#777777');
    });
});
