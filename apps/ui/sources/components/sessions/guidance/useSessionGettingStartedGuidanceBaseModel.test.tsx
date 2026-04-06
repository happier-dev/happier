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
    machineListStatusByServerId: {
        'srv-a': 'idle',
    } as Record<string, string | undefined>,
    serverProfilesGeneration: 1,
    serverProfiles: [
        { id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' },
    ] as Array<{ id: string; name: string; serverUrl: string }>,
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

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => guidanceState.serverProfiles,
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => guidanceState.serverProfilesGeneration,
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
});
