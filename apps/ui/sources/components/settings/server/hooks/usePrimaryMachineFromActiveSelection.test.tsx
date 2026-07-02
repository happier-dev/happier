import * as React from 'react';
import { act } from 'react-test-renderer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const activeServerRuntimeState = vi.hoisted(() => ({
    current: { serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 },
    listeners: new Set<(snapshot: { serverId: string; serverUrl: string; generation: number }) => void>(),
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    getEffectiveServerSelectionFromRawSettings: vi.fn(() => ({ serverIds: ['server-a'] })),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: vi.fn(() => activeServerRuntimeState.current),
    subscribeActiveServer: vi.fn((listener: (snapshot: { serverId: string; serverUrl: string; generation: number }) => void) => {
        activeServerRuntimeState.listeners.add(listener);
        return () => {
            activeServerRuntimeState.listeners.delete(listener);
        };
    }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: vi.fn(() => [
        { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1 },
        { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 2 },
    ]),
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => profile.serverIdentityId ?? profile.id,
}));

installServerSettingsHooksCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAllMachines: vi.fn(() => []),
            useMachineListByServerId: vi.fn(() => ({})),
            useMachineListStatusByServerId: vi.fn(() => ({})),
            useSetting: vi.fn((key: string) => null),
        });
    },
});

type PrimaryMachineSelection = string | null;

describe('usePrimaryMachineFromActiveSelection', () => {
    beforeEach(() => {
        activeServerRuntimeState.current = {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        };
        activeServerRuntimeState.listeners.clear();
    });

    it('updates when the active server changes without remounting', async () => {
        const { usePrimaryMachineFromActiveSelection } = await import('./usePrimaryMachineFromActiveSelection');
        const { useAllMachines, useMachineListByServerId } = await import('@/sync/domains/state/storage');
        const { getEffectiveServerSelectionFromRawSettings } = await import('@/sync/domains/server/selection/serverSelectionResolution');

        (useAllMachines as any).mockReturnValue([
            { id: 'm-a1', revokedAt: null, metadata: { displayName: 'Server A Machine 1' } },
        ]);
        (useMachineListByServerId as any).mockReturnValue({
            'server-b': [
                { id: 'm-b1', revokedAt: null, metadata: { displayName: 'Server B Machine 1' } },
            ],
        });
        (getEffectiveServerSelectionFromRawSettings as any).mockReturnValue({ serverIds: [] });

        const captured: PrimaryMachineSelection[] = [];
        function Probe() {
            const value = usePrimaryMachineFromActiveSelection();
            React.useEffect(() => {
                captured.push(value);
            }, [value]);

            return null;
        }

        await renderScreen(<Probe />);
        expect(captured.at(-1)).toBe('m-a1');

        await act(async () => {
            activeServerRuntimeState.current = {
                serverId: 'server-b',
                serverUrl: 'https://b.example.test',
                generation: 2,
            };
            activeServerRuntimeState.listeners.forEach((listener) => listener(activeServerRuntimeState.current));
        });

        expect(captured.at(-1)).toBe('m-b1');
    });

    it('returns the first machine from the first visible machine group', async () => {
        const { usePrimaryMachineFromActiveSelection } = await import('./usePrimaryMachineFromActiveSelection');
        const { useAllMachines, useMachineListByServerId } = await import('@/sync/domains/state/storage');
        const { getEffectiveServerSelectionFromRawSettings } = await import('@/sync/domains/server/selection/serverSelectionResolution');

        (useAllMachines as any).mockReturnValue([
            { id: 'm1', revokedAt: null, metadata: { displayName: 'Machine 1' } },
            { id: 'm2', revokedAt: null, metadata: { displayName: 'Machine 2' } },
        ]);
        (useMachineListByServerId as any).mockReturnValue({});
        (getEffectiveServerSelectionFromRawSettings as any).mockReturnValue({ serverIds: ['server-a'] });

        const captured: PrimaryMachineSelection[] = [];
        function Probe() {
            const value = usePrimaryMachineFromActiveSelection();
            React.useEffect(() => {
                captured.push(value);
            }, [value]);

            return null;
        }

        await renderScreen(<Probe />);

        const latest = captured.at(-1);
        expect(latest).toBe('m1');
    });

    it('returns null when no machines are available', async () => {
        const { usePrimaryMachineFromActiveSelection } = await import('./usePrimaryMachineFromActiveSelection');
        const { useAllMachines } = await import('@/sync/domains/state/storage');
        (useAllMachines as any).mockReturnValue([]);

        const captured: PrimaryMachineSelection[] = [];
        function Probe() {
            const value = usePrimaryMachineFromActiveSelection();
            React.useEffect(() => {
                captured.push(value);
            }, [value]);

            return null;
        }

        await renderScreen(<Probe />);

        const latest = captured.at(-1);
        expect(latest).toBe(null);
    });

    it('skips revoked machines', async () => {
        const { usePrimaryMachineFromActiveSelection } = await import('./usePrimaryMachineFromActiveSelection');
        const { useAllMachines } = await import('@/sync/domains/state/storage');
        (useAllMachines as any).mockReturnValue([
            { id: 'm-revoked', revokedAt: 123, metadata: { displayName: 'Revoked' } },
            { id: 'm-ok', revokedAt: null, metadata: { displayName: 'OK' } },
        ]);

        const captured: PrimaryMachineSelection[] = [];
        function Probe() {
            const value = usePrimaryMachineFromActiveSelection();
            React.useEffect(() => {
                captured.push(value);
            }, [value]);

            return null;
        }

        await renderScreen(<Probe />);

        const latest = captured.at(-1);
        expect(latest).toBe('m-ok');
    });

    it('uses machines from the first visible server in multi-server mode', async () => {
        const { usePrimaryMachineFromActiveSelection } = await import('./usePrimaryMachineFromActiveSelection');
        const { useAllMachines, useMachineListByServerId } = await import('@/sync/domains/state/storage');
        const { getEffectiveServerSelectionFromRawSettings } = await import('@/sync/domains/server/selection/serverSelectionResolution');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');

        (getActiveServerSnapshot as any).mockReturnValue({ serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 });
        (useAllMachines as any).mockReturnValue([
            { id: 'm-a1', revokedAt: null, metadata: { displayName: 'Server A Machine 1' } },
        ]);
        (useMachineListByServerId as any).mockReturnValue({
            'server-b': [
                { id: 'm-b1', revokedAt: null, metadata: { displayName: 'Server B Machine 1' } },
            ],
        });
        (getEffectiveServerSelectionFromRawSettings as any).mockReturnValue({ serverIds: ['server-b', 'server-a'] });

        const captured: PrimaryMachineSelection[] = [];
        function Probe() {
            const value = usePrimaryMachineFromActiveSelection();
            React.useEffect(() => {
                captured.push(value);
            }, [value]);

            return null;
        }

        await renderScreen(<Probe />);

        const latest = captured.at(-1);
        expect(latest).toBe('m-b1');
    });

    it('falls back to active machines when the active server scoped cache is empty', async () => {
        const { usePrimaryMachineFromActiveSelection } = await import('./usePrimaryMachineFromActiveSelection');
        const { useAllMachines, useMachineListByServerId } = await import('@/sync/domains/state/storage');

        (useAllMachines as any).mockReturnValue([
            { id: 'm-active', revokedAt: null, metadata: { displayName: 'Machine Active' } },
        ]);
        (useMachineListByServerId as any).mockReturnValue({
            'server-a': [],
        });

        const captured: PrimaryMachineSelection[] = [];
        function Probe() {
            const value = usePrimaryMachineFromActiveSelection();
            React.useEffect(() => {
                captured.push(value);
            }, [value]);

            return null;
        }

        await renderScreen(<Probe />);

        const latest = captured.at(-1);
        expect(latest).toBe('m-active');
    });

    it('uses identity-backed server scope ids when resolving the primary machine', async () => {
        const { usePrimaryMachineFromActiveSelection } = await import('./usePrimaryMachineFromActiveSelection');
        const { useAllMachines, useMachineListByServerId } = await import('@/sync/domains/state/storage');
        const { getEffectiveServerSelectionFromRawSettings } = await import('@/sync/domains/server/selection/serverSelectionResolution');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const profiles = await import('@/sync/domains/server/serverProfiles');

        (getActiveServerSnapshot as any).mockImplementation(() => activeServerRuntimeState.current);
        (profiles.listServerProfiles as any).mockReturnValue([
            {
                id: 'server-a',
                name: 'Server A',
                serverUrl: 'https://a.example.test',
                serverIdentityId: 'srv-a',
                lastUsedAt: 1,
            },
        ]);
        activeServerRuntimeState.current = {
            serverId: 'srv-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        };
        (useAllMachines as any).mockReturnValue([]);
        (useMachineListByServerId as any).mockReturnValue({
            'srv-a': [
                { id: 'm-identity', revokedAt: null, metadata: { displayName: 'Identity Machine' } },
            ],
        });
        (getEffectiveServerSelectionFromRawSettings as any).mockReturnValue({ serverIds: ['srv-a'] });

        const captured: PrimaryMachineSelection[] = [];
        function Probe() {
            const value = usePrimaryMachineFromActiveSelection();
            React.useEffect(() => {
                captured.push(value);
            }, [value]);

            return null;
        }

        await renderScreen(<Probe />);

        expect(getEffectiveServerSelectionFromRawSettings).toHaveBeenLastCalledWith(expect.objectContaining({
            activeServerId: 'srv-a',
            availableServerIds: ['srv-a'],
        }));
        expect(captured.at(-1)).toBe('m-identity');
    });
});
