import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

type BuildSessionGettingStartedViewModel = typeof import('./gettingStartedModel').buildSessionGettingStartedViewModel;

const buildSessionGettingStartedViewModel = vi.fn<BuildSessionGettingStartedViewModel>((input) => ({
    kind: 'create_session',
    targetLabel: 'Selected servers',
    serverId: input.activeServerProfile.id,
    serverName: input.activeServerProfile.name,
    serverUrl: input.activeServerProfile.serverUrl,
    showServerSetup: false,
}));

const guidanceState = vi.hoisted(() => ({
    summary: {
        sessionsReady: true,
        sessionCount: 1,
    },
    serverSelectionGroups: [] as Array<{ id: string; name: string }> ,
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'srv-a',
        allowedServerIds: ['srv-a'],
        explicit: false,
        activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
    } as any,
    machineListByServerId: {
        'srv-a': [{ active: true }],
    } as Record<string, Array<{ active: boolean }> | null | undefined>,
    activeMachines: [{ active: true }] as Array<{ active: boolean }>,
    localDaemonStatus: {
        serviceInstalled: false,
        daemonRunning: false,
        needsAuth: true,
        machineId: null as string | null,
    },
    machineListStatusByServerId: {
        'srv-a': 'idle',
    } as Record<string, string | undefined>,
    serverProfilesGeneration: 1,
    serverProfiles: [
        { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
    ] as Array<{
        id: string;
        name: string;
        serverUrl: string;
        serverIdentityId?: string;
        legacyServerIds?: string[];
    }>,
}));

vi.mock('./gettingStartedModel', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./gettingStartedModel')>();
    return {
        ...actual,
        buildSessionGettingStartedViewModel,
    };
});

vi.mock('@/hooks/session/useVisibleSessionListSummaryState', () => ({
    useVisibleSessionListSummaryState: () => ({
        selection: guidanceState.selection,
        summary: guidanceState.summary,
    }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useAllMachines: () => guidanceState.activeMachines,
        useMachineListByServerId: () => guidanceState.machineListByServerId,
        useSetting: (key: string) => {
            if (key === 'serverSelectionGroups') {
                return guidanceState.serverSelectionGroups;
            }
            return null;
        },
    });
});

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => guidanceState.serverProfiles,
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => guidanceState.serverProfilesGeneration,
}));

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: guidanceState.localDaemonStatus,
    }),
}));

describe('useSessionGettingStartedGuidanceBaseModel', () => {
    afterEach(() => {
        standardCleanup();
        buildSessionGettingStartedViewModel.mockClear();
        guidanceState.serverSelectionGroups = [];
        guidanceState.summary = {
            sessionsReady: true,
            sessionCount: 1,
        };
        guidanceState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a'],
            explicit: false,
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
        };
        guidanceState.machineListByServerId = {
            'srv-a': [{ active: true }],
        };
        guidanceState.activeMachines = [{ active: true }];
        guidanceState.localDaemonStatus = {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: true,
            machineId: null,
        };
        guidanceState.machineListStatusByServerId = {
            'srv-a': 'idle',
        };
        guidanceState.serverProfilesGeneration = 1;
        guidanceState.serverProfiles = [
            { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
        ];
    });

    it('keeps the model stable when only machine status changes', async () => {
        const { useSessionGettingStartedGuidanceBaseModel } = await import('./useSessionGettingStartedGuidanceBaseModel');
        const hook = await renderHook(({ tick }: { tick: number }) => {
            void tick;
            return useSessionGettingStartedGuidanceBaseModel();
        }, { initialProps: { tick: 0 } });
        await flushHookEffects();

        guidanceState.machineListStatusByServerId = {
            'srv-a': 'loading',
        };

        await hook.rerender({ tick: 1 });

        expect(buildSessionGettingStartedViewModel).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()).toBe(buildSessionGettingStartedViewModel.mock.results[0]?.value);
    });

    it('rebuilds the model when server profiles change', async () => {
        const { useSessionGettingStartedGuidanceBaseModel } = await import('./useSessionGettingStartedGuidanceBaseModel');
        const hook = await renderHook(({ tick }: { tick: number }) => {
            void tick;
            return useSessionGettingStartedGuidanceBaseModel();
        }, { initialProps: { tick: 0 } });
        await flushHookEffects();

        guidanceState.serverProfiles = [
            { id: 'srv-a', name: 'Renamed', serverUrl: 'https://api.renamed.example' },
        ];
        guidanceState.serverProfilesGeneration = 2;

        await hook.rerender({ tick: 1 });

        expect(buildSessionGettingStartedViewModel).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            serverName: 'Renamed',
            serverUrl: 'https://api.renamed.example',
        }));
    });

    it('resolves active server profile by server identity id', async () => {
        guidanceState.selection = {
            enabled: false,
            presentation: 'grouped',
            activeServerId: 'srv_local_relay',
            allowedServerIds: ['srv_local_relay'],
            explicit: false,
            activeTarget: { kind: 'server', id: 'srv_local_relay', serverId: 'srv_local_relay' },
        };
        guidanceState.serverProfiles = [
            { id: 'localhost-18830', name: 'localhost:18830', serverUrl: 'http://localhost:18830' },
            {
                id: 'localhost-52753',
                name: 'localhost:52753',
                serverUrl: 'http://localhost:52753',
                serverIdentityId: 'srv_local_relay',
                legacyServerIds: ['old-local-relay'],
            },
        ];

        const { useSessionGettingStartedGuidanceBaseModel } = await import('./useSessionGettingStartedGuidanceBaseModel');
        const hook = await renderHook(() => useSessionGettingStartedGuidanceBaseModel());
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            serverId: 'localhost-52753',
            serverName: 'localhost:52753',
            serverUrl: 'http://localhost:52753',
        }));
        expect(buildSessionGettingStartedViewModel.mock.calls.at(-1)?.[0].activeServerProfile).toEqual({
            id: 'localhost-52753',
            name: 'localhost:52753',
            serverUrl: 'http://localhost:52753',
            serverIdentityId: 'srv_local_relay',
            legacyServerIds: ['old-local-relay'],
        });
    });

    it('rebuilds the model when local daemon health changes', async () => {
        const { useSessionGettingStartedGuidanceBaseModel } = await import('./useSessionGettingStartedGuidanceBaseModel');
        const hook = await renderHook(({ tick }: { tick: number }) => {
            void tick;
            return useSessionGettingStartedGuidanceBaseModel();
        }, { initialProps: { tick: 0 } });
        await flushHookEffects();

        guidanceState.localDaemonStatus = {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-1',
        };

        await hook.rerender({ tick: 1 });

        expect(buildSessionGettingStartedViewModel).toHaveBeenCalledTimes(2);
        expect(buildSessionGettingStartedViewModel.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            localDaemonStatus: guidanceState.localDaemonStatus,
        }));
    });
});
