import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-image', () => ({
    Image: undefined,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#000000',
            },
        },
    });
});

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSource: () => 1,
    getAgentIconSvgXml: () => null,
    getAgentIconTintColor: () => undefined,
}));

describe('AgentIcon (expo-image missing)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders raster agent icons without crashing when expo-image omits Image', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        await expect(
            renderScreen(
                <AgentIcon
                    agentId={'codex' as any}
                    size={24}
                />,
            ),
        ).resolves.toBeTruthy();
    });
});
