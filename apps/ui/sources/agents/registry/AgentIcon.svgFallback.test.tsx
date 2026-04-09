import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-svg', () => ({
    SvgXml: undefined,
}));

vi.mock('expo-image', () => ({
    Image: (props: any) => React.createElement('ExpoImage', props),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#000',
            },
        },
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSource: () => null,
    getAgentIconSvgXml: () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
    getAgentIconTintColor: () => undefined,
}));

describe('AgentIcon', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        standardCleanup();
    });

    it('falls back to rendering SVG XML via Image when SvgXml is unavailable', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <AgentIcon agentId={'codex' as any} size={24} />,
        );

        const image = screen.findByType('ExpoImage' as any);
        expect(image.props.source?.uri).toMatch(/^data:image\/svg\+xml/);
    });
});
