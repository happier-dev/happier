import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installNewPickRouteCommonModuleMocks } from './newPickRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const navigationDispatchSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
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
                    activeAt: Date.now(),
                    seq: 1,
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                },
            ],
        },
    ] as any[],
}));

let capturedMachineSelectionContentProps: any = null;

vi.mock('react-native-reanimated', () => ({}));

installNewPickRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    header: { tint: '#111' },
                    textSecondary: '#666',
                    groupped: { background: '#fff' },
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const module = createExpoRouterMock({
            navigation: {
                getState: () => ({
                    index: 1,
                    routes: [
                        {
                            key: 'new-route',
                            name: '(app)/new/index',
                            path: '/new',
                            params: {
                                machineId: 'machine-1',
                                spawnServerId: 'server-b',
                            },
                        },
                        {
                            key: 'current-route',
                            name: '(app)/new/pick/machine',
                            path: '/new/pick/machine',
                        },
                    ],
                }),
                dispatch: navigationDispatchSpy,
            },
            router: {
                push: vi.fn(),
                back: routerBackSpy,
                replace: routerReplaceSpy,
                setParams: vi.fn(),
            },
        }).module;

        return {
            ...module,
            useLocalSearchParams: () => state.localSearchParams,
        };
    },
    storage: async (importOriginal) => (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
        importOriginal,
        overrides: {
            useAllMachines: () => ([
                {
                    id: 'machine-1',
                    metadata: {
                        host: 'host-1',
                        displayName: 'Machine 1',
                        homeDir: '/home/me',
                        platform: 'darwin',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/Users/tester/.happy-dev',
                    },
                    active: true,
                    createdAt: 1,
                    updatedAt: 1,
                    activeAt: Date.now(),
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
        },
    }),
});

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({
            type: 'SET_PARAMS',
            payload: { params },
        }),
    },
}));

vi.mock('@/components/sessions/new/components/NewSessionMachineSelectionContent', () => ({
    NewSessionMachineSelectionContent: (props: any) => {
        capturedMachineSelectionContentProps = props;
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
    afterEach(() => {
        standardCleanup();
    });

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
                        activeAt: Date.now(),
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
        capturedMachineSelectionContentProps = null;

        const Screen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(Screen));

        expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();

        await act(async () => {
            capturedMachineSelectionContentProps.onSelectMachine({
                id: 'machine-1',
                metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
            });
            await flushHookEffects();
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
        capturedMachineSelectionContentProps = null;

        const Screen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(Screen));

        await act(async () => {
            capturedMachineSelectionContentProps.onSelectMachine({
                id: 'machine-1',
                serverId: 'server-c',
                metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
            } as any);
            await flushHookEffects();
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
        capturedMachineSelectionContentProps = null;

        state.localSearchParams = {
            selectedId: '',
            spawnServerId: 'server-b',
        };

        const Screen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects();

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
        capturedMachineSelectionContentProps = null;

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

        const Screen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects();

        expect(navigationDispatchSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('refreshes machines on mount so newly registered daemons appear in the fallback picker route', async () => {
        refreshMachinesThrottledSpy.mockReset();

        const Screen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects();

        expect(refreshMachinesThrottledSpy).toHaveBeenCalledWith({
            staleMs: 0,
            force: true,
        });
    });

    it('normalizes invalid requested serverId to the allowed active target server', async () => {
        setActiveServerAndSwitchSpy.mockReset();
        navigationDispatchSpy.mockReset();
        routerBackSpy.mockReset();
        capturedMachineSelectionContentProps = null;

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
                        activeAt: Date.now(),
                        seq: 1,
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                ],
            },
        ] as any;

        const Screen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(Screen));

        expect(capturedMachineSelectionContentProps).toBeTruthy();
        expect(capturedMachineSelectionContentProps.serverId).toBe('server-b');

        await act(async () => {
            capturedMachineSelectionContentProps.onSelectMachine({
                id: 'machine-1',
                metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
            } as any);
            await flushHookEffects();
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
        capturedMachineSelectionContentProps = null;
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
                        activeAt: Date.now(),
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

        const Screen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(Screen));

        expect(capturedMachineSelectionContentProps).toBeTruthy();
        expect(capturedMachineSelectionContentProps.groups).toHaveLength(2);
        expect(capturedMachineSelectionContentProps.onSelectScopedMachine).toEqual(expect.any(Function));
    });
});
