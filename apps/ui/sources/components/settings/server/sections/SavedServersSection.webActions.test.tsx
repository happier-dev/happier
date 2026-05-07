import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#999999',
                },
            },
        });
    },
});

vi.mock('@/hooks/server/useServerRetentionPolicies', () => ({
    useServerRetentionPolicies: () => ({}),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props),
}));

describe('SavedServersSection web actions', () => {
    it('renders saved server rows without row press handlers when inline actions are present', async () => {
        const { SavedServersSection } = await import('./SavedServersSection');

        const screen = await renderScreen(React.createElement(SavedServersSection, {
            servers: [
                {
                    id: 'server-a',
                    name: 'Active',
                    serverUrl: 'https://active.example',
                    source: 'manual',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
            ],
            activeServerId: 'server-a',
            authStatusByServerId: {
                'server-a': 'signedIn',
            },
            onSwitch: vi.fn(),
            onRename: vi.fn(),
            onRemove: vi.fn(),
        }));

        const row = screen.findByType('Item' as never);
        expect(row?.props?.onPress).toBeUndefined();
    });

    it('exposes stable inline switch action test ids for saved server rows on web', async () => {
        const { SavedServersSection } = await import('./SavedServersSection');

        const screen = await renderScreen(React.createElement(SavedServersSection, {
            servers: [
                {
                    id: 'server-b',
                    name: 'Secondary',
                    serverUrl: 'https://secondary.example',
                    source: 'manual',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
            ],
            activeServerId: 'server-a',
            authStatusByServerId: {
                'server-b': 'signedIn',
            },
            onSwitch: vi.fn(),
            onRename: vi.fn(),
            onRemove: vi.fn(),
        }));

        const row = screen.findByType('Item' as never);
        const rowActions = row?.props?.rightElement;
        expect(rowActions?.props?.actions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'switch-device',
                    inlineTestID: 'saved-server-switch-server-b',
                }),
            ]),
        );
    });
});
