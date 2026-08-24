import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';


import { createCapturingComponent, createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedItems: Array<Record<string, unknown>> = [];
const getCredentialsForServerUrlMock = vi.fn(async (_serverUrl: string, _options?: { serverId?: string | null }) => ({ accessToken: 'token' }));
const expoRouterMock = createExpoRouterMock({
    params: { selectedId: 'server-a' },
    navigation: { dispatch: vi.fn(), getState: () => undefined },
    router: { replace: vi.fn() },
});

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
    reactNative: () => createReactNativeWebMock({
        View: createPassThroughComponent('View'),
        Pressable: createPassThroughComponent('Pressable'),
        Platform: {
            OS: 'ios',
            select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
        },
    }),
    router: () => expoRouterMock.module,
    storage: () => createStorageModuleStub({
        useSetting: (key: string) => {
            if (key === 'serverSelectionGroups') return [];
            if (key === 'serverSelectionActiveTargetKind') return 'all';
            if (key === 'serverSelectionActiveTargetId') return null;
            return null;
        },
    }),
    text: () => createTextModuleMock(),
    unistyles: () => createUnistylesMock({
        theme: {
            colors: {
                groupped: { background: '#fff' },
                text: '#111',
                textSecondary: '#666',
            },
        },
    }),
});

vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList', 'ItemListStatic']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: createCapturingComponent('Item', (props) => {
        capturedItems.push(props);
    }),
}));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text']));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        importOriginal,
        overrides: {
            getActiveServerSnapshot: () => ({
                generation: 1,
                serverId: 'server-a',
                serverUrl: 'http://server-a.local',
                activeShareableServerUrl: null,
                activeLocalRelayUrl: null,
            }),
            listServerProfiles: () => [
                {
                    id: 'server-a',
                    name: 'Server A',
                    serverUrl: 'http://server-a.local',
                    serverIdentityId: null,
                    legacyServerIds: [],
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
                {
                    id: 'server-b',
                    name: 'Server B',
                    serverUrl: 'http://server-b.local',
                    serverIdentityId: null,
                    legacyServerIds: [],
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                },
            ],
        },
    });
});

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    resolveActiveServerSelectionFromRawSettings: () => ({
        allowedServerIds: ['server-a', 'server-b'],
    }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (serverUrl: string, options?: { serverId?: string | null }) =>
            getCredentialsForServerUrlMock(serverUrl, options),
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

vi.mock('@/components/sessions/new/navigation/setNewSessionPickerReturnParams', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/sessions/new/navigation/setNewSessionPickerReturnParams')>()),
    setNewSessionPickerReturnParams: vi.fn(() => 'dispatch'),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean));
    }
    return (style as Record<string, unknown> | undefined) ?? {};
}

describe('NewSessionServerSelectionContent', () => {
    it('checks auth against the selected server profile id, not just its URL', async () => {
        capturedItems.length = 0;
        getCredentialsForServerUrlMock.mockClear();
        const { NewSessionServerSelectionContent } = await import('./NewSessionServerSelectionContent');

        await renderScreen(<NewSessionServerSelectionContent
                    maxHeight={520}
                    onClose={() => {}}
                    selectedServerId="server-b"
                />);

        const serverB = capturedItems.find((item) => item.title === 'Server B');
        expect(serverB).toBeTruthy();

        await React.act(async () => {
            (serverB?.onPress as (() => void) | undefined)?.();
        });

        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://server-b.local', { serverId: 'server-b' });
    });

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

    it('treats maxHeight as a cap instead of a fixed server-popover height', async () => {
        const { NewSessionServerSelectionContent } = await import('./NewSessionServerSelectionContent');

        const screen = await renderScreen(<NewSessionServerSelectionContent
                    maxHeight={520}
                    onClose={() => {}}
                    selectedServerId="server-b"
                />);

        const rootView = screen.findAllByType('View' as never)[0];
        const rootStyle = flattenStyle(rootView?.props.style);
        expect(rootStyle.maxHeight).toBe(520);
        expect(rootStyle.height).toBeUndefined();
        expect(rootStyle.flex).toBeUndefined();
    });
});
