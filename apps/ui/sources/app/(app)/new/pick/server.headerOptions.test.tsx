import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastScreenOptions: any = null;

vi.mock('expo-router', () => ({
    Stack: {
        Screen: (props: any) => {
            lastScreenOptions = props.options;
            return null;
        },
    },
    useLocalSearchParams: () => ({ selectedId: '' }),
    useNavigation: () => ({ getState: () => ({ index: 1, routes: [{ key: 'prev' }, { key: 'current' }] }), dispatch: () => {} }),
    useRouter: () => ({ back: () => {} }),
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: { setParams: (params: any) => ({ type: 'SET_PARAMS', payload: params }) },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#000' },
                textSecondary: '#666',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ generation: 1, serverId: 'server-a' }),
    listServerProfiles: () => [
        { id: 'server-a', name: 'A', serverUrl: 'http://a', lastUsedAt: 2 },
        { id: 'server-b', name: 'B', serverUrl: 'http://b', lastUsedAt: 1 },
    ],
}));

vi.mock('@/sync/domains/server/multiServer', () => ({
    getNewSessionServerTargeting: () => ({ allowedServerIds: ['server-a', 'server-b'] }),
}));

import ServerPickerScreen from './server';

describe('ServerPickerScreen header options', () => {
    it('does not provide a headerTitle function that returns a raw string (RN Web text node error)', () => {
        lastScreenOptions = null;
        act(() => {
            renderer.create(React.createElement(ServerPickerScreen));
        });

        expect(lastScreenOptions).toBeTruthy();
        expect(lastScreenOptions.headerTitle === undefined || typeof lastScreenOptions.headerTitle === 'string').toBe(true);
    });
});
