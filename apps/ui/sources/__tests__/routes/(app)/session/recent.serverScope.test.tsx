import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const mockNavigateToSession = vi.fn();
const mockSessions = vi.hoisted(() => ({
    all: [] as any[],
}));

vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        FlatList: ({ data, renderItem, keyExtractor, contentContainerStyle, ...rest }: any) => (
            React.createElement(
                'FlatList',
                { data, contentContainerStyle, ...rest },
                data.map((item: any, index: number) => React.createElement(
                    React.Fragment,
                    { key: keyExtractor?.(item, index) ?? `item:${index}` },
                    renderItem({ item, index }),
                )),
            )
        ),
    });
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props, null),
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => mockNavigateToSession,
}));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: createStorageStoreMock({
                sessions: {},
                machines: {},
            }),
            useAllSessions: () => mockSessions.all,
        },
    });
});

describe('Recent sessions route', () => {
    beforeEach(() => {
        mockNavigateToSession.mockReset();
        mockSessions.all = [];
    });

    it('preserves the owning serverId when opening a recent session', async () => {
        mockSessions.all = [
            {
                id: 'session-1',
                serverId: 'server-recent',
                active: true,
                updatedAt: Date.now(),
                metadata: { name: 'Recent Session', path: '/tmp/recent' },
            },
        ];

        const Screen = (await import('@/app/(app)/session/recent')).default;
        const screen = await renderScreen(<Screen />);
        const pressable = screen.root.find((node: any) => typeof node.props?.onPress === 'function');

        pressable.props.onPress();

        expect(mockNavigateToSession).toHaveBeenCalledWith('session-1', { serverId: 'server-recent' });
    });

    it('publishes a server-scoped navigation cursor for the order it renders', async () => {
        mockSessions.all = [
            {
                id: 'session-1',
                serverId: 'server-recent',
                active: true,
                updatedAt: 2_000,
                metadata: { name: 'Recent Session', path: '/tmp/recent' },
            },
            {
                id: 'session-2',
                serverId: 'server-recent',
                active: true,
                updatedAt: 1_000,
                metadata: { name: 'Older Session', path: '/tmp/older' },
            },
        ];

        const { readSessionNavigationCursor, resetSessionNavigationCursorForTests } = await import(
            '@/sync/domains/session/navigation/sessionNavigationCursorStore'
        );
        resetSessionNavigationCursorForTests();

        const Screen = (await import('@/app/(app)/session/recent')).default;
        await renderScreen(<Screen />);

        const cursor = readSessionNavigationCursor();
        expect(cursor?.identity.origin).toBe('recent');
        expect(cursor?.entries.map((entry) => entry.sessionKey)).toEqual([
            'server-recent:session-1',
            'server-recent:session-2',
        ]);
    });
});
