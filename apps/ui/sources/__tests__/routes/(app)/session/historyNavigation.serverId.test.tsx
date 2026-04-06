import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pressable } from 'react-native';

import { createStorageModuleStub, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createCapturingFlatListMock } from '@/dev/testkit/mocks/flashList';
import { installSessionRouteCommonModuleMocks } from './[id]/sessionRouteTestHelpers';

const navigateToSessionSpy = vi.fn();
const flatListMock = createCapturingFlatListMock({ renderItems: true });

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            FlatList: flatListMock.module.FlatList,
        });
    },
    storageModule: async () => {
        return createStorageModuleStub({
            useAllSessions: () => [
                {
                    id: 'session-history-1',
                    serverId: 'server-history',
                    updatedAt: 100,
                    name: 'History session',
                },
                {
                    id: 'session-archived-1',
                    serverId: 'server-archived',
                    updatedAt: 90,
                    archivedAt: 80,
                    name: 'Archived session',
                },
            ] as any,
        });
    },
});

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

describe('session history navigation', () => {
    beforeEach(() => {
        navigateToSessionSpy.mockReset();
    });

    it('passes the row server id when navigating from recent sessions', async () => {
        const RecentSessionsScreen = (await import('@/app/(app)/session/recent')).default;
        const screen = await renderScreen(React.createElement(RecentSessionsScreen));

        const row = screen.tree.findAllByType(Pressable)[0];
        expect(row).toBeTruthy();

        await pressTestInstanceAsync(row!, 'history session row');

        expect(navigateToSessionSpy).toHaveBeenCalledWith('session-history-1', { serverId: 'server-history' });
    });

    it('passes the row server id when navigating from archived sessions', async () => {
        const ArchivedSessionsScreen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(React.createElement(ArchivedSessionsScreen));

        const row = screen.tree.findAllByType(Pressable)[0];
        expect(row).toBeTruthy();

        await pressTestInstanceAsync(row!, 'archived session row');

        expect(navigateToSessionSpy).toHaveBeenCalledWith('session-archived-1', { serverId: 'server-archived' });
    });

    afterEach(() => {
        standardCleanup();
    });
});
