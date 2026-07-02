import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
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
const getCredentialsForServerUrlMock = vi.hoisted(() =>
    vi.fn(async () => ({ token: 'token', secret: 'secret' } as { token: string; secret: string } | null)),
);
const expoRouterMock = createExpoRouterMock({
    params: { selectedId: 'server-a' },
    navigation: { dispatch: vi.fn(), getState: () => undefined },
    router: { replace: vi.fn() },
});

type StyleLikeProps = Readonly<{
    style?: unknown;
}>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign(
            {} as Record<string, unknown>,
            ...style.filter(Boolean).map((entry) => flattenStyle(entry)),
        );
    }
    return (style as Record<string, unknown> | undefined) ?? {};
}

function readProps<P>(node: ReactTestInstance): P {
    return node.props as P;
}

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

vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemListStatic']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: createCapturingComponent('Item', (props) => {
        capturedItems.push(props);
    }),
}));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text']));

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
        getCredentialsForServerUrl: getCredentialsForServerUrlMock,
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

vi.mock('@/components/sessions/new/navigation/setNewSessionPickerReturnParams', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/new/navigation/setNewSessionPickerReturnParams')>();
    return {
        ...actual,
        setNewSessionPickerReturnParams: vi.fn(() => 'dispatch'),
    };
});

describe('NewSessionServerSelectionContent', () => {
    it('prefers the explicit selected server over stale route params in popover mode', async () => {
        capturedItems.length = 0;
        getCredentialsForServerUrlMock.mockClear();
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

    it('looks up credentials using the selected server id when deciding whether to prompt on switch', async () => {
        capturedItems.length = 0;
        getCredentialsForServerUrlMock.mockClear();
        getCredentialsForServerUrlMock.mockResolvedValueOnce(null);
        const { NewSessionServerSelectionContent } = await import('./NewSessionServerSelectionContent');

        await renderScreen(<NewSessionServerSelectionContent
                    maxHeight={520}
                    onClose={() => {}}
                    selectedServerId="server-b"
                />);

        const serverBItem = capturedItems.find((item) => item.title === 'Server B');
        if (!serverBItem || typeof serverBItem.onPress !== 'function') {
            throw new Error('Expected Server B item with onPress handler');
        }

        await serverBItem.onPress();

        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://server-b.local', { serverId: 'server-b' });
    });

    it('caps the popover content without forcing every server picker to max height', async () => {
        const { NewSessionServerSelectionContent } = await import('./NewSessionServerSelectionContent');

        const screen = await renderScreen(<NewSessionServerSelectionContent
                    maxHeight={333}
                    onClose={() => {}}
                    selectedServerId="server-a"
                />);

        const cappedContainer = screen.findAllByType('View').find((node) => {
            const style = flattenStyle(readProps<StyleLikeProps>(node).style);
            return style.maxHeight === 333;
        });

        expect(cappedContainer).toBeDefined();
        const style = flattenStyle(readProps<StyleLikeProps>(cappedContainer!).style);
        expect(style.maxHeight).toBe(333);
        expect(style.height).toBeUndefined();
        expect(style.flex).toBeUndefined();
    });
});
