import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    getEffectiveServerSelectionFromRawSettings: vi.fn(() => ({ serverIds: ['server-a'] })),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: vi.fn(() => ({ serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 })),
    listServerProfiles: vi.fn(() => [{ id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1 }]),
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
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');

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
});
