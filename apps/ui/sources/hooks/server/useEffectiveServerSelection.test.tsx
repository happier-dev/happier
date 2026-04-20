import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const state = vi.hoisted(() => ({
    activeServerSnapshot: {
        serverId: '',
        serverUrl: '',
        generation: 1,
    },
    serverProfilesGeneration: 1,
    serverProfiles: [] as ReadonlyArray<{ id: string; name: string; serverUrl: string }>,
    settings: {
        serverSelectionGroups: null as ReadonlyArray<unknown> | null,
        serverSelectionActiveTargetKind: null as 'server' | 'group' | null,
        serverSelectionActiveTargetId: null as string | null,
    },
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => state.activeServerSnapshot,
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => state.serverProfilesGeneration,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => state.serverProfiles,
}));

const storageMock = createStorageModuleStub({
    useSetting: (key: keyof typeof state.settings) => state.settings[key],
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

describe('useResolvedActiveServerSelection', () => {
    afterEach(() => {
        standardCleanup();
        state.activeServerSnapshot = {
            serverId: '',
            serverUrl: '',
            generation: 1,
        };
        state.serverProfilesGeneration = 1;
        state.serverProfiles = [];
        state.settings = {
            serverSelectionGroups: null,
            serverSelectionActiveTargetKind: null,
            serverSelectionActiveTargetId: null,
        };
    });

    it('recomputes the resolved active server when profiles hydrate after an empty pass', async () => {
        const { useResolvedActiveServerSelection } = await import('./useEffectiveServerSelection');
        const hook = await renderHook(() => useResolvedActiveServerSelection());

        expect(hook.getCurrent()).toEqual({
            activeTarget: { kind: 'server', id: '', serverId: '' },
            activeServerId: '',
            allowedServerIds: [],
            enabled: false,
            presentation: 'grouped',
            explicit: false,
        });

        state.serverProfiles = [{ id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' }];
        state.serverProfilesGeneration = 2;

        await hook.rerender();

        expect(hook.getCurrent()).toEqual({
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a'],
            enabled: false,
            presentation: 'grouped',
            explicit: false,
        });
    });
});

describe('useEffectiveServerSelection', () => {
    afterEach(() => {
        standardCleanup();
        state.activeServerSnapshot = {
            serverId: '',
            serverUrl: '',
            generation: 1,
        };
        state.serverProfilesGeneration = 1;
        state.serverProfiles = [];
        state.settings = {
            serverSelectionGroups: null,
            serverSelectionActiveTargetKind: null,
            serverSelectionActiveTargetId: null,
        };
    });

    it('recomputes the effective active server when profiles hydrate after an empty pass', async () => {
        const { useEffectiveServerSelection } = await import('./useEffectiveServerSelection');
        const hook = await renderHook(() => useEffectiveServerSelection());

        expect(hook.getCurrent()).toEqual({
            enabled: false,
            serverIds: [],
            presentation: 'grouped',
        });

        state.serverProfiles = [{ id: 'srv-a', name: 'A', serverUrl: 'https://api.a.example' }];
        state.serverProfilesGeneration = 2;

        await hook.rerender();

        expect(hook.getCurrent()).toEqual({
            enabled: false,
            serverIds: ['srv-a'],
            presentation: 'grouped',
        });
    });
});
