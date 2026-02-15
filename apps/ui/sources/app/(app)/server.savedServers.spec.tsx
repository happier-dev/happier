import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-typography', () => ({
    human: {},
    iOSUIKit: {},
    material: {},
}));

vi.mock('react-native', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        KeyboardAvoidingView: 'KeyboardAvoidingView',
        Platform: { ...actual.Platform, OS: 'ios' },
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('expo-updates', () => ({
    reloadAsync: vi.fn(),
}));

const routerReplaceMock = vi.fn();
let localSearchParamsMock: Record<string, any> = {};
const switchConnectionToActiveServerSpy = vi.fn(async (_params?: unknown) => null);
const refreshFromActiveServerSpy = vi.fn(async () => {});
let capturedRowActions: Record<string, any[]> = {};
let capturedRoundButtons: Array<{ title: string; onPress?: () => void; action?: () => void }> = [];
let capturedItemPressesByTitle: Record<string, Array<() => void>> = {};

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: any) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) }
    ),
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: routerReplaceMock }),
    useLocalSearchParams: () => localSearchParamsMock,
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: refreshFromActiveServerSpy }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => null),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: vi.fn(async () => true),
        prompt: vi.fn(async () => null),
        alert: vi.fn(),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, subtitle, rightElement, onPress }: any) => {
        const key = String(title ?? '');
        if (typeof onPress === 'function') {
            const existing = capturedItemPressesByTitle[key] ?? [];
            capturedItemPressesByTitle[key] = [...existing, onPress];
        }
        return React.createElement(
        React.Fragment,
        null,
        React.createElement('Text', null, `${title}${subtitle ? ` ${subtitle}` : ''}`),
        rightElement ? React.createElement('Right', null, rightElement) : null,
        );
    },
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
    RoundButton: ({ title, onPress, action }: any) => {
        capturedRoundButtons.push({ title: String(title ?? ''), onPress, action });
        return React.createElement('Text', null, title);
    },
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
        capturedRoundButtons = [];
        capturedItemPressesByTitle = {};
    });

    afterEach(() => {
        localSearchParamsMock = {};
    });

    it('renders saved server profiles', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const company = upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
        setActiveServerId(company.id, { scope: 'device' });

        const Screen = (await import('./server')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });

        expect(tree).toBeTruthy();
        const rendered = tree!.toJSON();
        expect(rendered).toBeTruthy();
        expect(JSON.stringify(rendered)).toContain('Company');
    });

    it('auto=1 upserts and activates server then redirects away', async () => {
        localSearchParamsMock = { url: 'https://company.example.test', auto: '1' };
        routerReplaceMock.mockClear();
        switchConnectionToActiveServerSpy.mockClear();
        refreshFromActiveServerSpy.mockClear();

        const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
        (globalThis as any).fetch = fetchSpy;

        const { getActiveServerId } = await import('@/sync/domains/server/serverProfiles');

        const Screen = (await import('./server')).default;

        await act(async () => {
            renderer.create(React.createElement(Screen));
            // Allow async effects (fetch, state updates) to settle under act().
            await new Promise((r) => setTimeout(r, 0));
        });

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

        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(fetchSpy).toHaveBeenCalledWith('https://company.example.test/v1/version', expect.any(Object));
        expect(fetchSpy).not.toHaveBeenCalledWith('https://company.example.test', expect.any(Object));
        expect(switchConnectionToActiveServerSpy).not.toHaveBeenCalled();
        expect(refreshFromActiveServerSpy).not.toHaveBeenCalled();
        expect(routerReplaceMock).not.toHaveBeenCalledWith('/');
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

        const Screen = (await import('./server')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await new Promise((r) => setTimeout(r, 0));
        });
        expect(tree).toBeTruthy();
        expect(JSON.stringify(tree!.toJSON())).toContain('Cloud Embedded');

        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        if (previousConfigured === undefined) delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
        else process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS = previousConfigured;
    });

    it('seeds default selection when deleting the active server group (never leaves 0 selected servers)', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const a = upsertServerProfile({ serverUrl: 'http://localhost:3013', name: 'a' });
        const b = upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'b' });
        setActiveServerId(a.id, { scope: 'device' });

        const { getStorage } = await import('@/sync/domains/state/storage');
        const store = getStorage();
        store.getState().applySettingsLocal({
            serverSelectionGroups: [
                { id: 'grp', name: 'Group', serverIds: [a.id, b.id], presentation: 'grouped' },
            ],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'grp',
        } as any);

        const Screen = (await import('./server')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await new Promise((r) => setTimeout(r, 0));
        });
        expect(tree).toBeTruthy();

        const actions = capturedRowActions['Group'] ?? [];
        const remove = actions.find((a) => a?.id === 'remove');
        expect(remove).toBeTruthy();

        await act(async () => {
            await remove.onPress();
            await new Promise((r) => setTimeout(r, 0));
        });

        const next = store.getState().settings;
        expect(next.serverSelectionActiveTargetKind).toBe('server');
        expect(next.serverSelectionActiveTargetId).toBe(a.id);
    });

    it('switching to a server selects an explicit server target and disables group mode', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const a = upsertServerProfile({ serverUrl: 'http://localhost:3013', name: 'Server A' });
        const b = upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'Server B' });
        setActiveServerId(a.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        (TokenStorage.getCredentialsForServerUrl as any).mockResolvedValue({ token: 'token', secret: 'secret' });

        const { getStorage } = await import('@/sync/domains/state/storage');
        const store = getStorage();
        store.getState().applySettingsLocal({
            serverSelectionGroups: [
                { id: 'grp', name: 'Group', serverIds: [a.id, b.id], presentation: 'grouped' },
            ],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'grp',
        } as any);

        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await new Promise((r) => setTimeout(r, 0));
        });

        const actions = capturedRowActions['Server B'] ?? [];
        const switchAction = actions.find((a) => a?.id === 'switch');
        expect(switchAction).toBeTruthy();

        await act(async () => {
            await switchAction.onPress();
            await new Promise((r) => setTimeout(r, 0));
        });

        const next = store.getState().settings;
        expect(next.serverSelectionActiveTargetKind).toBe('server');
        expect(next.serverSelectionActiveTargetId).toBe(b.id);
    });

    it('does not change active target settings when cancelling a signed-out server group switch', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const a = upsertServerProfile({ serverUrl: 'http://localhost:3013', name: 'Server A' });
        const b = upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'Server B' });
        setActiveServerId(a.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        (TokenStorage.getCredentialsForServerUrl as any).mockResolvedValue(null);

        const { Modal } = await import('@/modal');
        (Modal.confirm as any).mockClear();
        (Modal.confirm as any).mockResolvedValue(false);

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

        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await new Promise((r) => setTimeout(r, 0));
        });

        const actions = capturedRowActions['Group'] ?? [];
        const switchAction = actions.find((action) => action?.id === 'switch');
        expect(switchAction).toBeTruthy();

        await act(async () => {
            await switchAction.onPress();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(Modal.confirm).toHaveBeenCalledTimes(1);

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

        const Screen = (await import('./server')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await new Promise((r) => setTimeout(r, 0));
        });

        // Add-server form is collapsed by default; expand it first.
        const expandAddServer = (capturedItemPressesByTitle['server.addServerTitle'] ?? []).at(-1);
        expect(expandAddServer).toBeTruthy();
        await act(async () => {
            expandAddServer?.();
            await new Promise((r) => setTimeout(r, 0));
        });

        const urlInput = tree!.root
            .findAll((node) => node.props && typeof node.props.onChangeText === 'function')
            .find((node) => node.props.placeholder === 'common.urlPlaceholder');
        expect(urlInput).toBeTruthy();
        await act(async () => {
            urlInput!.props.onChangeText('http://localhost:3012');
        });

        const addAndUse = capturedRoundButtons.filter((button) => button.title === 'server.addAndUse').at(-1);
        expect(addAndUse?.action).toBeTruthy();

        await act(async () => {
            await addAndUse!.action!();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(switchConnectionToActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceMock).toHaveBeenCalledWith('/server');
    });

    it('creates a server group from the Add Server Group expander', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const a = upsertServerProfile({ serverUrl: 'http://localhost:3013', name: 'Server A' });
        const b = upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'Server B' });
        setActiveServerId(a.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        (TokenStorage.getCredentialsForServerUrl as any).mockResolvedValue({ token: 'token', secret: 'secret' });

        const { getStorage } = await import('@/sync/domains/state/storage');
        const store = getStorage();
        store.getState().applySettingsLocal({
            serverSelectionGroups: [],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: a.id,
        } as any);

        const Screen = (await import('./server')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await new Promise((r) => setTimeout(r, 0));
        });

        const expandAddGroup = (capturedItemPressesByTitle['server.addServerGroupTitle'] ?? []).at(-1);
        expect(expandAddGroup).toBeTruthy();
        await act(async () => {
            expandAddGroup?.();
            await new Promise((r) => setTimeout(r, 0));
        });

        const groupNameInput = tree!.root
            .findAll((node) => node.props && typeof node.props.onChangeText === 'function')
            .find((node) => node.props.placeholder === 'server.serverGroupNamePlaceholder');
        expect(groupNameInput).toBeTruthy();
        await act(async () => {
            groupNameInput!.props.onChangeText('My Group');
        });

        // Ensure server B is selected (server A is auto-selected by default from active server).
        const pressesForServerB = capturedItemPressesByTitle['Server B'] ?? [];
        expect(pressesForServerB.length).toBeGreaterThan(0);
        await act(async () => {
            pressesForServerB.at(-1)?.();
            await new Promise((r) => setTimeout(r, 0));
        });

        const saveGroup = capturedRoundButtons.filter((button) => button.title === 'server.saveServerGroup').at(-1);
        expect(saveGroup?.action).toBeTruthy();
        await act(async () => {
            await saveGroup!.action?.();
            await new Promise((r) => setTimeout(r, 0));
        });

        const next = store.getState().settings;
        expect(Array.isArray(next.serverSelectionGroups)).toBe(true);
        expect((next.serverSelectionGroups as any[]).length).toBe(1);
        expect(next.serverSelectionActiveTargetKind).toBe('group');
        expect(next.serverSelectionActiveTargetId).toBeTruthy();
        const group = (next.serverSelectionGroups as any[])[0] as { serverIds?: string[] };
        expect(group.serverIds).toEqual([a.id, b.id]);
    });
});
