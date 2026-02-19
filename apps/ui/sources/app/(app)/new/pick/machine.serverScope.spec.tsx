import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const navigationDispatchSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());
const setActiveServerAndSwitchSpy = vi.hoisted(() => vi.fn(async (_params: any) => false));
const refreshMachinesThrottledSpy = vi.hoisted(() => vi.fn(async () => {}));
const prefetchMachineCapabilitiesSpy = vi.hoisted(() => vi.fn(async () => {}));

const state = vi.hoisted(() => ({
    localSearchParams: {
        selectedId: 'machine-1',
        spawnServerId: 'server-b',
    },
    settings: {
        serverSelectionGroups: [] as Array<{ id: string; name: string; serverIds: string[]; presentation?: 'grouped' | 'flat-with-badge' }>,
        serverSelectionActiveTargetKind: 'server' as 'server' | 'group' | null,
        serverSelectionActiveTargetId: 'server-b' as string | null,
    },
}));

let activeServerId = 'server-a';
const scopedMachinesState = vi.hoisted(() => ({
    groups: [
        {
            serverId: 'server-b',
            serverName: 'Server B',
            loading: false,
            signedOut: false,
            machines: [
                {
                    id: 'machine-1',
                    serverId: 'server-b',
                    metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
                    active: true,
                    createdAt: 1,
                    updatedAt: 1,
                    activeAt: 1,
                    seq: 1,
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                },
            ],
        },
    ] as any[],
}));

let capturedMachineSelectorProps: any = null;
let capturedServerScopedMachineSelectorProps: any = null;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#111' },
                textSecondary: '#666',
                groupped: { background: '#fff' },
            },
        },
    }),
    StyleSheet: { create: (styles: any) => styles },
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
    useAllMachines: () => ([
        {
            id: 'machine-1',
            metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
            active: true,
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
            seq: 1,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        },
    ]),
    useSessions: () => [],
    useSetting: (key: string) => {
        if (key === 'useMachinePickerSearch') return false;
        return (state.settings as any)[key];
    },
    useSettingMutable: (key: string) => (key === 'favoriteMachines' ? [[], vi.fn()] : [undefined, vi.fn()]),
}));

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: any) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: any) => React.createElement(React.Fragment, null, children) },
    ),
    useRouter: () => ({ back: routerBackSpy }),
    useNavigation: () => ({
        getState: () => ({
            index: 1,
            routes: [{ key: 'prev-route' }, { key: 'current-route' }],
        }),
        dispatch: navigationDispatchSpy,
    }),
    useLocalSearchParams: () => state.localSearchParams,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: (props: any) => {
        capturedMachineSelectorProps = props;
        return null;
    },
}));

vi.mock('@/components/sessions/new/components/ServerScopedMachineSelector', () => ({
    ServerScopedMachineSelector: (props: any) => {
        capturedServerScopedMachineSelectorProps = props;
        return null;
    },
}));

vi.mock('@/utils/sessions/recentMachines', () => ({
    getRecentMachinesFromSessions: ({ machines }: { machines: unknown[] }) => machines,
}));

vi.mock('@/components/navigation/HeaderTitleWithAction', () => ({
    HeaderTitleWithAction: ({ title }: { title: string }) => React.createElement('Text', null, title),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: refreshMachinesThrottledSpy,
    },
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    prefetchMachineCapabilities: prefetchMachineCapabilitiesSpy,
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    invalidateMachineEnvPresence: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => activeServerId,
    listServerProfiles: () => ([
        { id: 'server-a', name: 'Server A', serverUrl: 'https://stack-a.example.test', lastUsedAt: 1000 },
        { id: 'server-b', name: 'Server B', serverUrl: 'https://stack-b.example.test', lastUsedAt: 900 },
        { id: 'server-c', name: 'Server C', serverUrl: 'https://stack-c.example.test', lastUsedAt: 800 },
    ]),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: async (params: any) => {
        setActiveServerAndSwitchSpy(params);
        activeServerId = String(params?.serverId ?? '').trim() || activeServerId;
        return true;
    },
}));

vi.mock('@/components/sessions/new/hooks/machines/useServerScopedMachineOptions', () => ({
    useServerScopedMachineOptions: () => scopedMachinesState.groups,
}));

describe('machine picker server scope', () => {
    beforeEach(() => {
        activeServerId = 'server-a';
        state.localSearchParams = {
            selectedId: 'machine-1',
            spawnServerId: 'server-b',
        };
        state.settings = {
            serverSelectionGroups: [],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'server-b',
        };
        scopedMachinesState.groups = [
            {
                serverId: 'server-b',
                serverName: 'Server B',
                loading: false,
                signedOut: false,
                machines: [
                    {
                        id: 'machine-1',
                        serverId: 'server-b',
                        metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
                        active: true,
                        createdAt: 1,
                        updatedAt: 1,
                        activeAt: 1,
                        seq: 1,
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                ],
            },
        ] as any;
    });

    it('propagates selected machine and server params back to new session route without switching global active server', async () => {
        setActiveServerAndSwitchSpy.mockReset();
        navigationDispatchSpy.mockReset();
        routerBackSpy.mockReset();
        refreshMachinesThrottledSpy.mockReset();
        prefetchMachineCapabilitiesSpy.mockReset();
        capturedMachineSelectorProps = null;
        capturedServerScopedMachineSelectorProps = null;

        const Screen = (await import('./machine')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();

        await act(async () => {
            capturedMachineSelectorProps.onSelect({
                id: 'machine-1',
                metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
            });
            await Promise.resolve();
        });

        expect(navigationDispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
            type: 'SET_PARAMS',
            payload: {
                params: expect.objectContaining({
                    machineId: 'machine-1',
                    spawnServerId: 'server-b',
                }),
            },
        }));
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
    });

    it('uses the selected machine serverId when provided (group target coherence)', async () => {
        setActiveServerAndSwitchSpy.mockReset();
        navigationDispatchSpy.mockReset();
        routerBackSpy.mockReset();
        refreshMachinesThrottledSpy.mockReset();
        prefetchMachineCapabilitiesSpy.mockReset();
        capturedMachineSelectorProps = null;

        const Screen = (await import('./machine')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        await act(async () => {
            capturedMachineSelectorProps.onSelect({
                id: 'machine-1',
                serverId: 'server-c',
                metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
            } as any);
            await Promise.resolve();
        });

        expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(navigationDispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
            type: 'SET_PARAMS',
            payload: {
                params: expect.objectContaining({
                    machineId: 'machine-1',
                    spawnServerId: 'server-c',
                }),
            },
        }));
    });

    it('auto-selects machine when selected server has exactly one machine', async () => {
        setActiveServerAndSwitchSpy.mockReset();
        navigationDispatchSpy.mockReset();
        routerBackSpy.mockReset();
        refreshMachinesThrottledSpy.mockReset();
        prefetchMachineCapabilitiesSpy.mockReset();
        capturedMachineSelectorProps = null;

        state.localSearchParams = {
            selectedId: '',
            spawnServerId: 'server-b',
        };

        const Screen = (await import('./machine')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(navigationDispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
            type: 'SET_PARAMS',
            payload: {
                params: expect.objectContaining({
                    machineId: 'machine-1',
                    spawnServerId: 'server-b',
                }),
            },
        }));
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
    });

    it('does not auto-select when the only machine for the selected server is offline', async () => {
        setActiveServerAndSwitchSpy.mockReset();
        navigationDispatchSpy.mockReset();
        routerBackSpy.mockReset();
        refreshMachinesThrottledSpy.mockReset();
        prefetchMachineCapabilitiesSpy.mockReset();
        capturedMachineSelectorProps = null;

        state.localSearchParams = {
            selectedId: '',
            spawnServerId: 'server-b',
        };

        scopedMachinesState.groups = [
            {
                serverId: 'server-b',
                serverName: 'Server B',
                loading: false,
                signedOut: false,
                machines: [
                    {
                        id: 'machine-1',
                        serverId: 'server-b',
                        metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
                        active: false,
                        createdAt: 1,
                        updatedAt: 1,
                        activeAt: 0,
                        seq: 1,
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                ],
            },
        ] as any;

        const Screen = (await import('./machine')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(navigationDispatchSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('normalizes invalid requested serverId to the allowed active target server', async () => {
        setActiveServerAndSwitchSpy.mockReset();
        navigationDispatchSpy.mockReset();
        routerBackSpy.mockReset();
        capturedMachineSelectorProps = null;

        state.localSearchParams = {
            selectedId: 'machine-1',
            spawnServerId: 'server-z',
        };
        state.settings.serverSelectionActiveTargetKind = 'server';
        state.settings.serverSelectionActiveTargetId = 'server-b';
        scopedMachinesState.groups = [
            {
                serverId: 'server-b',
                serverName: 'Server B',
                loading: false,
                signedOut: false,
                machines: [
                    {
                        id: 'machine-1',
                        serverId: 'server-b',
                        metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
                        active: true,
                        createdAt: 1,
                        updatedAt: 1,
                        activeAt: 1,
                        seq: 1,
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                ],
            },
        ] as any;

        const Screen = (await import('./machine')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        expect(capturedMachineSelectorProps).toBeTruthy();
        expect(capturedMachineSelectorProps.serverId).toBe('server-b');

        await act(async () => {
            capturedMachineSelectorProps.onSelect({
                id: 'machine-1',
                metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
            } as any);
            await Promise.resolve();
        });

        expect(navigationDispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
            type: 'SET_PARAMS',
            payload: {
                params: expect.objectContaining({
                    machineId: 'machine-1',
                    spawnServerId: 'server-b',
                }),
            },
        }));
    });

    it('renders grouped selector when target is a group with multiple servers', async () => {
        capturedMachineSelectorProps = null;
        capturedServerScopedMachineSelectorProps = null;
        state.settings.serverSelectionGroups = [
            {
                id: 'grp-dev',
                name: 'Dev Group',
                serverIds: ['server-b', 'server-c'],
                presentation: 'grouped',
            },
        ];
        state.settings.serverSelectionActiveTargetKind = 'group';
        state.settings.serverSelectionActiveTargetId = 'grp-dev';
        scopedMachinesState.groups = [
            {
                serverId: 'server-b',
                serverName: 'Server B',
                loading: false,
                signedOut: false,
                machines: [
                    {
                        id: 'machine-1',
                        serverId: 'server-b',
                        metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
                        active: true,
                        createdAt: 1,
                        updatedAt: 1,
                        activeAt: 1,
                        seq: 1,
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                ],
            },
            {
                serverId: 'server-c',
                serverName: 'Server C',
                loading: false,
                signedOut: false,
                machines: [],
            },
        ] as any;

        const Screen = (await import('./machine')).default;
        await act(async () => {
            renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        expect(capturedServerScopedMachineSelectorProps).toBeTruthy();
        expect(capturedMachineSelectorProps).toBeNull();
    });
});
