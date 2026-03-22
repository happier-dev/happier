import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeWithProps, flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SLOW_TEST_TIMEOUT_MS = 60_000;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-typography', () => ({
    human: {},
    iOSUIKit: {},
    material: {},
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                KeyboardAvoidingView: 'KeyboardAvoidingView',
                Platform: { OS: 'ios' },
            }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                groupped: { background: '#fff' },
                text: '#000',
                textSecondary: '#666',
                textDestructive: '#f00',
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                status: { connecting: '#00f' },
                divider: '#ccc',
                switch: {
                    track: { inactive: '#ddd', active: '#0a0' },
                    thumb: { active: '#fff' },
                },
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('expo-updates', () => ({
    reloadAsync: vi.fn(),
}));

vi.mock('@/hooks/server/useServerRetentionPolicies', () => ({
    useServerRetentionPolicies: () => ({}),
}));

const routerReplaceMock = vi.fn();
let localSearchParamsMock: Record<string, any> = {};
const switchConnectionToActiveServerSpy = vi.fn(async (_params?: unknown) => null);
const refreshFromActiveServerSpy = vi.fn(async () => {});
let capturedRowActions: Record<string, any[]> = {};
let pendingNotificationNavValue: { serverUrl: string; route: string } | null = null;
const clearPendingNotificationNavSpy = vi.fn();
const { modalMockRef } = vi.hoisted(() => ({
    modalMockRef: { current: null as any },
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: {
            back: vi.fn(),
            push: vi.fn(),
            replace: routerReplaceMock,
            setParams: vi.fn(),
        },
    });
    return {
        ...routerMock.module,
        useLocalSearchParams: () => localSearchParamsMock,
    };
});

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: refreshFromActiveServerSpy }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
        getCredentialsForServerUrl: vi.fn(async () => null),
        invalidateCredentialsTokenForServerUrl: vi.fn(async () => {}),
        removeCredentialsForServerUrl: vi.fn(async () => {}),
        setCredentialsForServerUrl: vi.fn(async () => {}),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock({ confirmResult: true });
    modalMockRef.current = modalMock;
    return modalMock.module;
});

vi.mock('@/sync/domains/pending/pendingNotificationNav', () => ({
    getPendingNotificationNav: () => pendingNotificationNavValue,
    setPendingNotificationNav: (next: { serverUrl: string; route: string }) => {
        pendingNotificationNavValue = next;
    },
    clearPendingNotificationNav: () => {
        clearPendingNotificationNavSpy();
        pendingNotificationNavValue = null;
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: ({ title, actions }: any) => {
        const key = String(title);
        const existing = capturedRowActions[key] ?? [];
        const next = Array.isArray(actions) ? actions : [];
        capturedRowActions[key] = [...existing, ...next];
        return null;
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

describe('ServerConfigScreen', () => {
    beforeEach(() => {
        vi.resetModules();
        localSearchParamsMock = {};
        routerReplaceMock.mockReset();
        switchConnectionToActiveServerSpy.mockReset();
        refreshFromActiveServerSpy.mockReset();
        delete (globalThis as any).fetch;
        capturedRowActions = {};
        pendingNotificationNavValue = null;
        clearPendingNotificationNavSpy.mockReset();
        modalMockRef.current?.spies.alert.mockReset();
        modalMockRef.current?.spies.confirm.mockReset();
        modalMockRef.current?.spies.prompt.mockReset();
    });

    afterEach(() => {
        localSearchParamsMock = {};
        standardCleanup();
    });

    async function renderServerScreen() {
        const Screen = (await import('@/app/(app)/server')).default;
        return renderScreen(React.createElement(Screen));
    }

    function findItemByTitle(
        screen: Awaited<ReturnType<typeof renderServerScreen>>,
        title: string,
    ) {
        return findTestInstanceByTypeWithProps(screen, 'Item' as any, { title: title }) ?? null;
    }

    function findRoundButtonByTitle(
        screen: Awaited<ReturnType<typeof renderServerScreen>>,
        title: string,
    ) {
        return findTestInstanceByTypeWithProps(screen, 'RoundButton' as any, { title: title }) ?? null;
    }

    it('renders saved server profiles', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const company = upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
        setActiveServerId(company.id, { scope: 'device' });

        const screen = await renderServerScreen();
        expect(findItemByTitle(screen, 'Company')).toBeTruthy();
    }, SLOW_TEST_TIMEOUT_MS);

    it('auto=1 upserts and activates server then redirects away', async () => {
        localSearchParamsMock = { url: 'https://company.example.test', auto: '1' };
        routerReplaceMock.mockClear();
        switchConnectionToActiveServerSpy.mockClear();
        refreshFromActiveServerSpy.mockClear();

        const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
        (globalThis as any).fetch = fetchSpy;

        const { getActiveServerId } = await import('@/sync/domains/server/serverProfiles');

        await renderServerScreen();

        expect(getActiveServerId()).toBeTruthy();
        expect(fetchSpy).toHaveBeenCalledWith('https://company.example.test/v1/version', expect.any(Object));
        expect(switchConnectionToActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(refreshFromActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceMock).toHaveBeenCalledWith('/');
    });

    it('does not fall back to legacy root probe when /v1/version is not ok', async () => {
        localSearchParamsMock = { url: 'https://company.example.test', auto: '1' };
        routerReplaceMock.mockClear();
        switchConnectionToActiveServerSpy.mockClear();
        refreshFromActiveServerSpy.mockClear();

        const fetchSpy = vi.fn(async (url: string) => {
            if (url === 'https://company.example.test/v1/version') {
                return { ok: false, json: async () => ({}) };
            }
            if (url === 'https://company.example.test') {
                return { ok: true, text: async () => 'Welcome to Happier Server!' };
            }
            return { ok: false, text: async () => '' };
        });
        (globalThis as any).fetch = fetchSpy;

        await renderServerScreen();

        expect(fetchSpy).toHaveBeenCalledWith('https://company.example.test/v1/version', expect.any(Object));
        expect(fetchSpy).not.toHaveBeenCalledWith('https://company.example.test', expect.any(Object));
        expect(switchConnectionToActiveServerSpy).not.toHaveBeenCalled();
        expect(refreshFromActiveServerSpy).not.toHaveBeenCalled();
        expect(routerReplaceMock).not.toHaveBeenCalledWith('/');
    });

    it('navigates to pending notification session after adding a server from a notification deep link', async () => {
        localSearchParamsMock = { url: 'https://company.example.test', source: 'notification' };
        pendingNotificationNavValue = { serverUrl: 'https://company.example.test', route: '/session/s_123' };

        const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
        (globalThis as any).fetch = fetchSpy;

        const screen = await renderServerScreen();

        const addButton = findRoundButtonByTitle(screen, 'server.addAndUse');
        expect(addButton).toBeTruthy();

        await act(async () => {
            await addButton!.props.action?.();
        });
        await flushHookEffects();

        expect(clearPendingNotificationNavSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceMock).toHaveBeenCalledWith('/session/s_123');
    });

    it('renders a preconfigured server as a normal saved server entry', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const previousConfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = JSON.stringify([
            { name: 'Cloud Embedded', url: 'https://api.happier.dev' },
        ]);
        vi.resetModules();

        const screen = await renderServerScreen();
        expect(findItemByTitle(screen, 'Cloud Embedded')).toBeTruthy();

        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        if (previousConfigured === undefined) delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        else process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = previousConfigured;
    });

    it('does not change active target settings when cancelling a signed-out server group switch', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const a = upsertServerProfile({ serverUrl: 'http://localhost:3013', name: 'Server A' });
        const b = upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'Server B' });
        setActiveServerId(a.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        (TokenStorage.getCredentialsForServerUrl as any).mockResolvedValue(null);

        await import('@/modal');
        modalMockRef.current.spies.confirm.mockClear();
        modalMockRef.current.spies.confirm.mockResolvedValue(false);

        const { getStorage } = await import('@/sync/domains/state/storage');
        const store = getStorage();
        store.getState().applySettingsLocal({
            serverSelectionGroups: [
                { id: 'grp', name: 'Group', serverIds: [b.id], presentation: 'grouped' },
            ],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: a.id,
        } as any);

        const before = store.getState().settings;

        await renderServerScreen();

        const actions = capturedRowActions['Group'] ?? [];
        const switchAction = actions.find((action) => action?.id === 'switch');
        expect(switchAction).toBeTruthy();

        await act(async () => {
            await switchAction.onPress();
        });
        await flushHookEffects();

        expect(modalMockRef.current.spies.confirm).toHaveBeenCalledTimes(1);

        const after = store.getState().settings;
        expect(after.serverSelectionActiveTargetKind).toBe(before.serverSelectionActiveTargetKind);
        expect(after.serverSelectionActiveTargetId).toBe(before.serverSelectionActiveTargetId);
        expect(after.serverSelectionGroups).toEqual(before.serverSelectionGroups);
    });

    it('cleans stale server query from the route after add-and-use succeeds', async () => {
        localSearchParamsMock = { server: 'http://localhost:3012' };
        routerReplaceMock.mockClear();
        switchConnectionToActiveServerSpy.mockClear();
        refreshFromActiveServerSpy.mockClear();

        const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
        (globalThis as any).fetch = fetchSpy;

        const screen = await renderServerScreen();

        // Add-server form is collapsed by default; expand it first.
        const expandAddServer = findItemByTitle(screen, 'server.addServerTitle');
        expect(expandAddServer).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(expandAddServer);
        });
        await flushHookEffects();

        const urlInput = screen.root
            .findAll((node) => node.props && typeof node.props.onChangeText === 'function')
            .find((node) => node.props.placeholder === 'common.urlPlaceholder');
        expect(urlInput).toBeTruthy();
        await act(async () => {
            urlInput!.props.onChangeText('http://localhost:3012');
        });

        const addAndUse = findRoundButtonByTitle(screen, 'server.addAndUse');
        expect(addAndUse?.props.action).toBeTruthy();

        await act(async () => {
            await addAndUse!.props.action!();
        });
        await flushHookEffects();

        expect(switchConnectionToActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceMock).toHaveBeenCalledWith('/server');
    });

});
