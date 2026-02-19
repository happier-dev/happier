import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useActiveSelectionMachineGroups } from './useActiveSelectionMachineGroups';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    getEffectiveServerSelectionFromRawSettings: () => ({ serverIds: ['server-a'] }),
}));

type ProbeProps = Readonly<{
    allMachines: any[];
    onValue: (value: ReturnType<typeof useActiveSelectionMachineGroups>) => void;
}>;

function Probe(props: ProbeProps) {
    const value = useActiveSelectionMachineGroups({
        activeServerSnapshot: { serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 } as any,
        allMachines: props.allMachines as any,
        serverProfiles: [{ id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1 }] as any,
        machineListByServerId: {},
        machineListStatusByServerId: {},
        settings: {
            serverSelectionGroups: null,
            serverSelectionActiveTargetKind: null,
            serverSelectionActiveTargetId: null,
        },
    });

    React.useEffect(() => {
        props.onValue(value);
    }, [value, props]);

    return null;
}

describe('useActiveSelectionMachineGroups', () => {
    it('filters revoked machines out of visible groups and hasAnyVisibleMachines', async () => {
        const captured: any[] = [];
        const allMachines = [
            { id: 'm-ok', revokedAt: null },
            { id: 'm-revoked', revokedAt: 123 },
        ];

        await act(async () => {
            renderer.create(<Probe allMachines={allMachines} onValue={(value) => captured.push(value)} />);
            await Promise.resolve();
        });

        const latest = captured.at(-1);
        expect(latest.visibleMachineGroups).toHaveLength(1);
        expect(latest.visibleMachineGroups[0].machines.map((m: any) => m.id)).toEqual(['m-ok']);
        expect(latest.hasAnyVisibleMachines).toBe(true);
    });

    it('reports no visible machines when all are revoked', async () => {
        const captured: any[] = [];
        const allMachines = [
            { id: 'm-revoked', revokedAt: 123 },
        ];

        await act(async () => {
            renderer.create(<Probe allMachines={allMachines} onValue={(value) => captured.push(value)} />);
            await Promise.resolve();
        });

        const latest = captured.at(-1);
        expect(latest.visibleMachineGroups[0].machines).toEqual([]);
        expect(latest.hasAnyVisibleMachines).toBe(false);
    });
});

