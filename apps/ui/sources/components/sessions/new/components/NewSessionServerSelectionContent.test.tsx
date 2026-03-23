import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';


import { createCapturingComponent, createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedItems: Array<Record<string, unknown>> = [];
const expoRouterMock = createExpoRouterMock({
    params: { selectedId: 'server-a' },
    navigation: { dispatch: vi.fn(), getState: () => undefined },
    router: { replace: vi.fn() },
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: createPassThroughComponent('View'),
                                    Pressable: createPassThroughComponent('Pressable'),
                                    Platform: {
                                        OS: 'ios',
                                        select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
                                    },
                                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: createPassThroughComponent('Ionicons'),
}));

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('react-native-unistyles', async () => await createUnistylesMock({
    theme: {
        colors: {
            groupped: { background: '#fff' },
            text: '#111',
            textSecondary: '#666',
        },
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: createCapturingComponent('Item', (props) => {
        capturedItems.push(props);
    }),
}));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text']));
vi.mock('@/text', () => createTextModuleMock());

vi.mock('@/sync/domains/state/storage', () => createStorageModuleStub({
    useSetting: (key: string) => {
        if (key === 'serverSelectionGroups') return [];
        if (key === 'serverSelectionActiveTargetKind') return 'all';
        if (key === 'serverSelectionActiveTargetId') return null;
        return null;
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({
        generation: 1,
        serverId: 'server-a',
    }),
    listServerProfiles: () => [
        { id: 'server-a', name: 'Server A', serverUrl: 'http://server-a.local' },
        { id: 'server-b', name: 'Server B', serverUrl: 'http://server-b.local' },
    ],
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    resolveActiveServerSelectionFromRawSettings: () => ({
        allowedServerIds: ['server-a', 'server-b'],
    }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => ({ accessToken: 'token' })),
    },
}));

vi.mock('@/components/settings/server/modals/ServerSwitchAuthPrompt', () => ({
    promptSignedOutServerSwitchConfirmation: vi.fn(async () => true),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => promise,
}));

vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: vi.fn(),
}));

vi.mock('@/components/sessions/new/navigation/setNewSessionPickerReturnParams', () => ({
    setNewSessionPickerReturnParams: vi.fn(() => 'dispatch'),
}));

describe('NewSessionServerSelectionContent', () => {
    it('prefers the explicit selected server over stale route params in popover mode', async () => {
        capturedItems.length = 0;
        const { NewSessionServerSelectionContent } = await import('./NewSessionServerSelectionContent');

        await renderScreen(<NewSessionServerSelectionContent
                    maxHeight={520}
                    onClose={() => {}}
                    selectedServerId="server-b"
                />);

        expect(capturedItems.map((item) => ({
            title: item.title,
            selected: item.selected,
        }))).toEqual([
            { title: 'Server A', selected: false },
            { title: 'Server B', selected: true },
        ]);
    });
});
