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

const catalogSpies = vi.hoisted(() => ({
    getAgentIconSource: vi.fn((agentId: string) => agentId === 'image' ? { uri: 'agent.png' } : null),
    getAgentIconSvgXml: vi.fn((agentId: string) => agentId === 'svg'
        ? '<svg fill="#111111" stroke="#222222"><path fill="#333333" stroke="none" /></svg>'
        : null),
    getAgentIconTintColor: vi.fn(() => '#444444'),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSource: catalogSpies.getAgentIconSource,
    getAgentIconSvgXml: catalogSpies.getAgentIconSvgXml,
    getAgentIconTintColor: catalogSpies.getAgentIconTintColor,
}));

describe('AgentIcon color override', () => {
    afterEach(() => {
        standardCleanup();
        catalogSpies.getAgentIconSource.mockClear();
        catalogSpies.getAgentIconSvgXml.mockClear();
        catalogSpies.getAgentIconTintColor.mockClear();
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

    it('does not recompute an unchanged icon on an equivalent parent render', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <>
                <AgentIcon
                    agentId="svg"
                    size={16}
                    color="#777777"
                />
                <HarnessTick value={0} />
            </>,
        );
        expect(catalogSpies.getAgentIconSvgXml).toHaveBeenCalledTimes(1);

        await screen.update(
            <>
                <AgentIcon
                    agentId="svg"
                    size={16}
                    color="#777777"
                />
                <HarnessTick value={1} />
            </>,
        );

        expect(catalogSpies.getAgentIconSvgXml).toHaveBeenCalledTimes(1);
    });
});

function HarnessTick(_props: { value: number }) {
    return null;
}
