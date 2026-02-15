import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    rows: [] as Array<{ title: string; onPress?: (() => void) | undefined }>,
    reset() {
        this.rows = [];
    },
}));

const state = vi.hoisted(() => ({
    activeServerId: 'server-a',
    activeServerUrl: 'https://stack-a.example.test',
    localSearchParams: {} as Record<string, unknown>,
    settings: {
        serverSelectionGroups: [] as Array<{ id: string; name: string; serverIds: string[]; presentation?: 'grouped' | 'flat-with-badge' }>,
        serverSelectionActiveTargetKind: null as 'server' | 'group' | null,
        serverSelectionActiveTargetId: null as string | null,
    },
    profiles: [
        { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A', lastUsedAt: 1000 },
        { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B', lastUsedAt: 900 },
        { id: 'server-c', serverUrl: 'https://stack-c.example.test', name: 'Server C', lastUsedAt: 800 },
    ],
}));

const navigationDispatchSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const tokenCredsSpy = vi.hoisted(() =>
    vi.fn<(serverUrl: string) => Promise<{ token: string; secret: string } | null>>(async () => ({ token: 't', secret: 's' }))
);
const setActiveServerAndSwitchSpy = vi.hoisted(() => vi.fn(async (_params: any) => true));
const refreshMachinesThrottledSpy = vi.hoisted(() => vi.fn(async (_params: any) => undefined));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
                header: { tint: '#111' },
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({
            type: 'SET_PARAMS',
            payload: { params },
        }),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => (state.settings as any)[key],
    useSettingMutable: (key: string) => ([
        (state.settings as any)[key],
        (value: unknown) => {
            (state.settings as any)[key] = value;
        },
    ] as const),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({
        serverId: state.activeServerId,
        serverUrl: state.activeServerUrl,
        kind: 'stack',
        generation: 1,
    }),
    listServerProfiles: () => state.profiles,
}));

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: any) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) }
    ),
    useRouter: () => ({ back: routerBackSpy, replace: routerReplaceSpy }),
    useNavigation: () => ({
        getState: () => ({
            index: 1,
            routes: [{ key: 'prev-route' }, { key: 'current-route' }],
        }),
        dispatch: navigationDispatchSpy,
    }),
    useLocalSearchParams: () => state.localSearchParams,
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: modalConfirmSpy,
    },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: tokenCredsSpy,
    },
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: async (params: any) => {
        return await setActiveServerAndSwitchSpy(params);
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: async (params: any) => {
            return await refreshMachinesThrottledSpy(params);
        },
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, onPress }: any) => {
        capture.rows.push({ title: String(title ?? ''), onPress });
        return null;
    },
}));

beforeEach(() => {
    capture.reset();
    navigationDispatchSpy.mockReset();
    routerBackSpy.mockReset();
    routerReplaceSpy.mockReset();
    modalConfirmSpy.mockReset();
    modalConfirmSpy.mockResolvedValue(true);
    tokenCredsSpy.mockReset();
    tokenCredsSpy.mockResolvedValue({ token: 't', secret: 's' });
    setActiveServerAndSwitchSpy.mockReset();
    refreshMachinesThrottledSpy.mockReset();
    state.localSearchParams = {};
    state.activeServerId = 'server-a';
    state.activeServerUrl = 'https://stack-a.example.test';
    state.settings = {
        serverSelectionGroups: [],
        serverSelectionActiveTargetKind: null,
        serverSelectionActiveTargetId: null,
    };
    state.profiles = [
        { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A', lastUsedAt: 1000 },
        { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B', lastUsedAt: 900 },
        { id: 'server-c', serverUrl: 'https://stack-c.example.test', name: 'Server C', lastUsedAt: 800 },
    ];
});

afterEach(() => {
    capture.reset();
});

describe('new-session server picker targeting', () => {
    it('shows only servers in the current active target selection (no groups)', async () => {
        state.settings.serverSelectionGroups = [
            {
                id: 'grp-dev',
                name: 'Dev Group',
                serverIds: ['server-a', 'server-c'],
                presentation: 'grouped',
            },
        ];
        state.settings.serverSelectionActiveTargetKind = 'group';
        state.settings.serverSelectionActiveTargetId = 'grp-dev';

        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        const titles = capture.rows.map((row) => row.title);
        expect(titles).toEqual(['Server A', 'Server C']);
    });

    it('selecting a server writes the spawnServerId param back to the previous route without mutating global target settings', async () => {
        state.settings.serverSelectionGroups = [
            {
                id: 'grp-dev',
                name: 'Dev Group',
                serverIds: ['server-a', 'server-c'],
                presentation: 'grouped',
            },
        ];
        state.settings.serverSelectionActiveTargetKind = 'group';
        state.settings.serverSelectionActiveTargetId = 'grp-dev';

        // Non-default selection should not affect the global app target selection.
        const before = { ...state.settings };

        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        const serverCRow = capture.rows.find((row) => row.title === 'Server C');
        expect(serverCRow).toBeTruthy();
        await act(async () => {
            serverCRow?.onPress?.();
            await Promise.resolve();
        });

        expect(navigationDispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
            type: 'SET_PARAMS',
            payload: {
                params: expect.objectContaining({
                    spawnServerId: 'server-c',
                }),
            },
        }));
        expect(state.settings).toEqual(before);
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
    });

    it('does not change settings or route params when cancelling a signed-out server selection', async () => {
        tokenCredsSpy.mockResolvedValue(null);
        modalConfirmSpy.mockResolvedValue(false);

        state.settings.serverSelectionGroups = [
            {
                id: 'grp-dev',
                name: 'Dev Group',
                serverIds: ['server-a', 'server-b'],
                presentation: 'grouped',
            },
        ];
        state.settings.serverSelectionActiveTargetKind = 'group';
        state.settings.serverSelectionActiveTargetId = 'grp-dev';

        const Screen = (await import('./server')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        const serverBRow = capture.rows.find((row) => row.title === 'Server B');
        expect(serverBRow).toBeTruthy();
        await act(async () => {
            serverBRow?.onPress?.();
            await Promise.resolve();
        });

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(navigationDispatchSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(state.settings.serverSelectionActiveTargetKind).toBe('group');
        expect(state.settings.serverSelectionActiveTargetId).toBe('grp-dev');
    });

    // Runtime server switching is handled by the new-session screen itself (tab-scoped),
    // not by the local picker.
});
