import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            text: '#111',
            textSecondary: '#777',
            surface: '#fff',
            groupped: { background: '#fafafa', sectionTitle: '#666' },
            shadowLevels: ['#00000000', '#00000012'],
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('./SessionListStorageTabsBar', () => ({
    SessionListStorageTabsBar: (props: any) => React.createElement('SessionListStorageTabsBar', props, props.children),
}));

describe('SessionsListStorageChrome', () => {
    beforeEach(() => {
        standardCleanup();
        routerPushSpy.mockReset();
    });

    it('renders the direct browse action as an item row and routes it to the direct browse screen', async () => {
        const { SessionsListStorageChrome } = await import('./SessionsListStorageChrome');
        const screen = await renderScreen(
            <SessionsListStorageChrome
                externalSessionsEnabled={true}
                storageKind="direct"
                onSelectStorageKind={() => {}}
            />,
        );

        expect(() => screen.findByType('ItemGroup' as never)).not.toThrow();
        expect(() => screen.findByProps({ testID: 'direct-sessions-browse-button' })).not.toThrow();

        await screen.pressByTestIdAsync('direct-sessions-browse-button');

        expect(routerPushSpy).toHaveBeenCalledWith('/direct/browse');
    });
});
