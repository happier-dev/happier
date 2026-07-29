import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';

const catalogState = vi.hoisted(() => ({ pages: [] as ResolvedSettingsPageNode[] }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog', () => ({
    useResolvedSettingsPageCatalog: () => ({
        tree: [{
            id: 'settings',
            titleKey: 'settings.title',
            route: '/settings',
            keywords: [],
            children: [{
                id: 'groupAiAndAgents',
                titleKey: 'settings.aiAndAgents',
                keywords: [],
                children: catalogState.pages,
            }],
        }],
        activePageId: null,
        search: () => [],
    }),
}));

function page(id: ResolvedSettingsPageNode['id'], titleKey: ResolvedSettingsPageNode['titleKey'], route: string): ResolvedSettingsPageNode {
    return { id, titleKey, route, keywords: [] };
}

describe('SettingsAiAndAgentsSection catalog projection', () => {
    it('renders exactly the resolved catalog children, including Providers', async () => {
        catalogState.pages = [
            page('agents', 'settingsAgents.title', '/settings/agents'),
            page('providers', 'settingsProviders.title', '/settings/providers'),
        ];
        const push = vi.fn();
        const { SettingsAiAndAgentsSection } = await import('./SettingsAiAndAgentsSection');
        const screen = await renderScreen(
            <SettingsAiAndAgentsSection
                router={{ push } as never}
                theme={{ colors: { accent: {}, state: {}, text: { secondary: '#777' } } } as never}
            />,
        );

        expect(screen.findAllByProps({ title: 'settingsAgents.title' })).toHaveLength(1);
        const providers = screen.findAllByProps({ title: 'settingsProviders.title' });
        expect(providers).toHaveLength(1);
        providers[0]?.props.onPress();
        expect(push).toHaveBeenCalledWith('/settings/providers');
    });

    it('does not invent a Providers row when the resolved catalog omits it', async () => {
        catalogState.pages = [page('agents', 'settingsAgents.title', '/settings/agents')];
        const { SettingsAiAndAgentsSection } = await import('./SettingsAiAndAgentsSection');
        const screen = await renderScreen(
            <SettingsAiAndAgentsSection
                router={{ push: vi.fn() } as never}
                theme={{ colors: { accent: {}, state: {}, text: { secondary: '#777' } } } as never}
            />,
        );

        expect(screen.findAllByProps({ title: 'settingsProviders.title' })).toHaveLength(0);
    });
});
