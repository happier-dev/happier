import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';

const catalogState = vi.hoisted(() => ({
    tree: [] as ResolvedSettingsPageNode[],
}));

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
        tree: catalogState.tree,
        activePageId: null,
        search: () => [],
    }),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

function accountTree(): ResolvedSettingsPageNode[] {
    return [{
        id: 'settings',
        title: 'Settings',
        route: '/settings',
        keywords: [],
        children: [{
            id: 'groupProfileAndAccount',
            title: 'Profile & Account',
            keywords: [],
            children: [{
                id: 'account',
                title: 'Account',
                route: '/settings/account',
                keywords: [],
                children: [{
                    id: 'apiTokens',
                    title: 'API Tokens',
                    subtitle: 'Automate securely',
                    route: '/settings/account/api-tokens',
                    keywords: [],
                }],
            }],
        }],
    }];
}

describe('SettingsCatalogPageChildren', () => {
    it('renders Account child destinations from the resolved catalog and navigates using their route', async () => {
        catalogState.tree = accountTree();
        const push = vi.fn();
        const { SettingsCatalogPageChildren } = await import('./SettingsCatalogOverviewGroup');
        const screen = await renderScreen(
            <SettingsCatalogPageChildren
                parentPageId="account"
                router={{ push } as never}
                theme={{ colors: { text: { secondary: '#777' } } } as never}
            />,
        );

        const apiTokens = screen.findByTestId('settings-catalog-page-item.apiTokens');
        expect(apiTokens?.props.title).toBe('API Tokens');
        expect(apiTokens?.props.subtitle).toBe('Automate securely');

        apiTokens?.props.onPress();
        expect(push).toHaveBeenCalledWith('/settings/account/api-tokens');
    });

    it('does not invent a destination when the resolved Account children omit it', async () => {
        catalogState.tree = [{
            ...accountTree()[0]!,
            children: [{
                ...accountTree()[0]!.children![0]!,
                children: [{
                    ...accountTree()[0]!.children![0]!.children![0]!,
                    children: [],
                }],
            }],
        }];
        const { SettingsCatalogPageChildren } = await import('./SettingsCatalogOverviewGroup');
        const screen = await renderScreen(
            <SettingsCatalogPageChildren
                parentPageId="account"
                router={{ push: vi.fn() } as never}
                theme={{ colors: { text: { secondary: '#777' } } } as never}
            />,
        );

        expect(screen.findByTestId('settings-catalog-page-item.apiTokens')).toBeNull();
    });
});
