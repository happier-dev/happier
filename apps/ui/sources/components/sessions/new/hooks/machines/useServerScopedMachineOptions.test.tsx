import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { storage } from '@/sync/domains/state/storageStore';
import { renderScreen } from '@/dev/testkit';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.restoreAllMocks();
    act(() => {
        storage.setState((state) => ({
            ...state,
            machineListByServerId: {},
            machineListStatusByServerId: {},
        }));
    });
});

type ProbeProps = Readonly<{
    allowedServerIds: string[];
    activeServerId: string;
    activeMachines: Machine[];
    refreshToken?: number;
    onGroups: (groups: ReturnType<typeof useServerScopedMachineOptions>) => void;
}>;

function Probe(props: ProbeProps) {
    const groups = useServerScopedMachineOptions({
        allowedServerIds: props.allowedServerIds,
        activeServerId: props.activeServerId,
        activeMachines: props.activeMachines,
        refreshToken: props.refreshToken,
    });
    React.useEffect(() => {
        props.onGroups(groups);
    }, [groups, props]);
    return null;
}

function createMachine(id: string): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: {
            host: id,
            displayName: id,
            homeDir: '/home/me',
            platform: 'darwin',
            happyHomeDir: '/home/me/.happier',
            happyCliVersion: '0.0.0-test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

describe('useServerScopedMachineOptions', () => {
    it('keeps a retained scoped picker row on its admitted Machine clock after continuing heartbeats', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS', '60000');
        const initialState = storage.getState();
        const machine = createMachine('scoped-clock');
        const allowedServerIds = ['server-b'];
        const activeMachines: Machine[] = [];
        let current: ReturnType<typeof useServerScopedMachineOptions> = [];
        storage.setState({ machineListByServerId: { 'server-b': [machine] },
            machineListStatusByServerId: { 'server-b': 'idle' } });
        const screen = await renderScreen(<Probe allowedServerIds={allowedServerIds} activeServerId="server-a"
            activeMachines={activeMachines} onGroups={groups => { current = groups; }} />);
        try {
            const projected = current[0]!.machines[0]!;
            const root = storage.getState();
            await act(async () => storage.getState().applyMachineActivityUpdates([
                { id: machine.id, active: true, activeAt: machine.activeAt + 30_000 },
            ], { sourceServerId: 'server-b' }));
            expect(storage.getState()).toBe(root);
            expect(current[0]!.machines[0]).toBe(projected);
            // The old structural timestamp has expired, but this retained row
            // must see the same still-current clock as its admitted Machine.
            expect(isMachineOnline(machine, machine.activeAt + 60_001)).toBe(true);
            expect(isMachineOnline(projected, machine.activeAt + 60_001)).toBe(true);
            expect(projected.activeAt).toBe(machine.activeAt);
        } finally {
            await screen.unmount();
            storage.setState(initialState, true);
            vi.unstubAllEnvs();
        }
    });

    it('retains unaffected scoped rows across unrelated Machine arrivals', async () => {
        const fleet = Array.from({ length: 100 }, (_, index) => createMachine(`picker-${index}`));
        const allowedServerIds = ['server-b'];
        const activeMachines: Machine[] = [];
        let current: ReturnType<typeof useServerScopedMachineOptions> = [];
        act(() => storage.setState({
            machineListByServerId: { 'server-b': fleet },
            machineListStatusByServerId: { 'server-b': 'idle' },
        }));
        const screen = await renderScreen(<Probe allowedServerIds={allowedServerIds} activeServerId="server-a"
            activeMachines={activeMachines} onGroups={groups => { current = groups; }} />);
        let unaffectedProjectionReplacements = 0;
        try {
            for (let arrival = 1; arrival <= 3; arrival += 1) {
                const previous = current[0]!.machines;
                const changed = { ...fleet[0]!, metadataVersion: arrival + 1,
                    metadata: { ...fleet[0]!.metadata!, displayName: `Changed ${arrival}` } };
                await act(async () => storage.setState({
                    machineListByServerId: { 'server-b': [changed, ...fleet.slice(1)] },
                }));
                const next = current[0]!.machines;
                expect(next[0]?.metadata?.displayName).toBe(`Changed ${arrival}`);
                expect(next[0]).not.toBe(previous[0]);
                unaffectedProjectionReplacements += next.slice(1).filter((row, index) => row !== previous[index + 1]).length;
            }
            // These are producer identities, not a consumer comparator: every retained
            // Machine feeds the picker accessory/mark props through this owner.
            expect(unaffectedProjectionReplacements).toBe(0);
            const priorRows = new Map(current[0]!.machines.map(row => [row.id, row]));
            const reordered = storage.getState().machineListByServerId['server-b']!.slice().reverse();
            await act(async () => storage.setState({ machineListByServerId: { 'server-b': reordered } }));
            expect(current[0]!.machines.every(row => row === priorRows.get(row.id))).toBe(true);
            const removed = fleet[1]!;
            await act(async () => storage.setState({
                machineListByServerId: { 'server-b': reordered.filter(row => row.id !== removed.id) },
            }));
            await act(async () => storage.setState({ machineListByServerId: { 'server-b': reordered } }));
            // Only the current projection is retained: a removed row is not
            // resurrected from a superseded inventory when its id returns.
            expect(current[0]!.machines.find(row => row.id === removed.id)).not.toBe(priorRows.get(removed.id));
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the same groups when a refreshed inventory leaves every row unchanged', async () => {
        const initialState = storage.getState();
        const machine = createMachine('stable-row');
        let current: ReturnType<typeof useServerScopedMachineOptions> = [];
        act(() => storage.setState({
            machineListByServerId: { 'server-b': [machine] },
            machineListStatusByServerId: { 'server-b': 'idle' },
        }));
        const allowedServerIds = ['server-b'];
        const screen = await renderScreen(<Probe allowedServerIds={allowedServerIds} activeServerId="server-a" activeMachines={[]} onGroups={(next) => { current = next; }} />);
        const before = current;
        // A refresh republishes the list with the identical Machine objects.
        act(() => storage.setState({ machineListByServerId: { 'server-b': [machine] } }));
        await screen.update(<Probe allowedServerIds={allowedServerIds} activeServerId="server-a" activeMachines={[]} onGroups={(next) => { current = next; }} />);
        expect(current).toBe(before);
        await screen.unmount();
        storage.setState(initialState, true);
    });

    it('publishes changed launch metadata without a consumer-owned field signature', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        const row = createMachine('inventory-change');
        const screen = await renderScreen(<Probe allowedServerIds={['server-a']} activeServerId="server-a"
            activeMachines={[row]} onGroups={groups => captured.push(groups)} />);
        for (const arch of ['arm64', 'x64', 'arm64']) {
            const changed = { ...row, metadataVersion: row.metadataVersion + 1, metadata: { ...row.metadata!, arch } };
            await screen.update(<Probe allowedServerIds={['server-a']} activeServerId="server-a"
                activeMachines={[changed]} onGroups={groups => captured.push(groups)} />);
            expect(captured.at(-1)?.[0]?.machines[0]?.metadata?.arch).toBe(arch);
        }
        await screen.unmount();
    });
    it.each(['populated', 'empty'] as const)('keeps a hydrated %s Home inventory ready through a profile-alias refresh', async (inventoryKind) => {
        const identity = `srv_launch_refresh_${inventoryKind}`;
        const profile = await adoptHomeProfile({ descriptor: {
            v: 1,
            homeServerIdentityId: identity,
            canonicalServerUrl: `https://launch-refresh-${inventoryKind}.example.test`,
            revision: 1,
            endpoints: [{ kind: 'https', url: `https://launch-refresh-${inventoryKind}.example.test` }],
        }, source: 'manual' });
        expect(profile.id).not.toBe(identity);
        const rows = inventoryKind === 'populated' ? [createMachine('machine-refresh')] : [];
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        act(() => storage.setState({
            machineListByServerId: { [identity]: rows },
            machineListStatusByServerId: { [identity]: 'idle' },
        }));
        await renderScreen(<Probe allowedServerIds={[profile.id]} activeServerId="foreign-home" activeMachines={[]}
            onGroups={(groups) => captured.push(groups)} />);
        expect(captured.at(-1)?.[0]).toMatchObject({
            machines: rows.map((row) => expect.objectContaining({ id: row.id })),
            loading: false,
            signedOut: false,
            error: false,
        });

        await act(async () => storage.setState({ machineListStatusByServerId: { [identity]: 'loading' } }));

        expect(captured.at(-1)?.[0]).toMatchObject({
            machines: rows.map((row) => expect.objectContaining({ id: row.id })),
            loading: false,
            signedOut: false,
            error: false,
        });
    });

    it.each(['signedOut', 'error'] as const)('honors canonical %s status for a requested Home profile alias', async (status) => {
        const identity = `srv_launch_terminal_${status}`;
        const profile = await adoptHomeProfile({ descriptor: {
            v: 1,
            homeServerIdentityId: identity,
            canonicalServerUrl: `https://launch-terminal-${status.toLowerCase()}.example.test`,
            revision: 1,
            endpoints: [{ kind: 'https', url: `https://launch-terminal-${status.toLowerCase()}.example.test` }],
        }, source: 'manual' });
        const rows = [createMachine('machine-terminal')];
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        act(() => storage.setState({
            machineListByServerId: { [identity]: rows },
            machineListStatusByServerId: { [identity]: 'loading' },
        }));
        await renderScreen(<Probe allowedServerIds={[profile.id]} activeServerId="foreign-home" activeMachines={[]}
            onGroups={(groups) => captured.push(groups)} />);

        await act(async () => storage.setState({
            machineListByServerId: { [identity]: status === 'signedOut' ? null : rows },
            machineListStatusByServerId: { [identity]: status },
        }));

        expect(captured.at(-1)?.[0]).toMatchObject({
            machines: status === 'signedOut' ? [] : [expect.objectContaining({ id: rows[0].id })],
            loading: false,
            signedOut: status === 'signedOut',
            error: status === 'error',
        });
    });

    it('updates an equivalent profile route when canonical inventory removes a machine', async () => {
        const identity = 'srv_launch_inventory_owner';
        const profile = await adoptHomeProfile({ descriptor: {
            v: 1, homeServerIdentityId: identity, canonicalServerUrl: 'https://launch-inventory-owner.example.test',
            revision: 1, endpoints: [{ kind: 'https', url: 'https://launch-inventory-owner.example.test' }],
        }, source: 'manual' });
        expect(profile.id).not.toBe(identity);
        const row = createMachine('machine-launch');
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        act(() => storage.setState({
            machineListByServerId: { [profile.id]: [row] },
            machineListStatusByServerId: { [profile.id]: 'idle' },
        }));
        await renderScreen(<Probe allowedServerIds={[profile.id]} activeServerId="foreign-home" activeMachines={[]}
            onGroups={(groups) => captured.push(groups)} />);
        expect(captured.at(-1)?.[0]?.machines.map((machine) => machine.id)).toEqual([row.id]);
        await act(async () => {
            storage.setState((state) => ({
                machineListByServerId: { ...state.machineListByServerId, [identity]: [] },
                machineListStatusByServerId: { ...state.machineListStatusByServerId, [identity]: 'idle' },
            }));
        });
        expect(captured.at(-1)?.[0]?.machines).toEqual([]);
    });

    it('refreshes groups when active machine freshness changes', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        const activeMachine = createMachine('machine-a');

        const screen = await renderScreen(<Probe
                    allowedServerIds={['server-a']}
                    activeServerId="server-a"
                    activeMachines={[{ ...activeMachine, activeAt: 100 }]}
                    onGroups={(groups) => captured.push(groups)}
                />);
        const firstGroups = captured.at(-1);

        await act(async () => {
            screen.tree.update(<Probe
                        allowedServerIds={['server-a']}
                        activeServerId="server-a"
                        activeMachines={[{ ...activeMachine, activeAt: 200 }]}
                        refreshToken={2}
                        onGroups={(groups) => captured.push(groups)}
                    />);
        });
        const secondGroups = captured.at(-1);

        expect(secondGroups).not.toBe(firstGroups);
        expect(secondGroups?.[0]?.machines[0]?.activeAt).toBe(200);
    });

    it('refreshes groups when scoped machine cache freshness changes', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        const activeMachine = createMachine('machine-a');
        const remoteMachine = createMachine('machine-cache');

        act(() => {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-b': [{ ...remoteMachine, activeAt: 100 }],
                },
                machineListStatusByServerId: {
                    ...state.machineListStatusByServerId,
                    'server-b': 'idle',
                },
            }));
        });

        const screen = await renderScreen(<Probe
                    allowedServerIds={['server-a', 'server-b']}
                    activeServerId="server-a"
                    activeMachines={[activeMachine]}
                    onGroups={(groups) => captured.push(groups)}
                />);
        const firstGroups = captured.at(-1);

        act(() => storage.getState().applyMachineActivityUpdates([
            { id: remoteMachine.id, active: remoteMachine.active, activeAt: 200 },
        ], { sourceServerId: 'server-b' }));

        await act(async () => {
            screen.tree.update(<Probe
                        allowedServerIds={['server-a', 'server-b']}
                        activeServerId="server-a"
                        activeMachines={[activeMachine]}
                        onGroups={(groups) => captured.push(groups)}
                    />);
        });
        const secondGroups = captured.at(-1);

        expect(secondGroups).not.toBe(firstGroups);
        expect(firstGroups?.find((group) => group.serverId === 'server-b')?.machines[0]?.activeAt).toBe(100);
        const currentRow = secondGroups?.find((group) => group.serverId === 'server-b')?.machines[0];
        expect(currentRow?.activeAt).toBe(100);
        expect(currentRow && readMachineActivity(currentRow).activeAt).toBe(200);
    });

    it('keeps active server machines and uses server-scoped machine cache for non-active servers', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        const activeMachine = createMachine('machine-a');
        const remoteCachedMachine = createMachine('machine-cache');

        act(() => {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-b': [remoteCachedMachine],
                },
                machineListStatusByServerId: {
                    ...state.machineListStatusByServerId,
                    'server-b': 'idle',
                },
            }));
        });

        await renderScreen(<Probe
                    allowedServerIds={['server-a', 'server-b']}
                    activeServerId="server-a"
                    activeMachines={[activeMachine]}
                    onGroups={(groups) => captured.push(groups)}
                />);

        const latest = captured.at(-1) ?? [];
        const activeGroup = latest.find((group) => group.serverId === 'server-a');
        const remoteGroup = latest.find((group) => group.serverId === 'server-b');
        expect(activeGroup?.machines.map((m) => m.id)).toEqual(['machine-a']);
        expect(remoteGroup?.machines.map((m) => m.id)).toEqual(['machine-cache']);
        expect(remoteGroup?.loading).toBe(false);
    });

    it('uses the active server cache when the active machine array has not hydrated yet', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        const cachedActiveMachine = createMachine('machine-a');

        act(() => {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-a': [cachedActiveMachine],
                },
                machineListStatusByServerId: {
                    ...state.machineListStatusByServerId,
                    'server-a': 'idle',
                },
            }));
        });

        await renderScreen(<Probe
                    allowedServerIds={['server-a']}
                    activeServerId="server-a"
                    activeMachines={[]}
                    onGroups={(groups) => captured.push(groups)}
                />);

        const latest = captured.at(-1) ?? [];
        const activeGroup = latest.find((group) => group.serverId === 'server-a');
        expect(activeGroup?.machines.map((m) => m.id)).toEqual(['machine-a']);
        expect(activeGroup?.loading).toBe(false);
    });

    it('marks server as signed out when its canonical inventory status is signed out', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];

        act(() => {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-b': null,
                },
                machineListStatusByServerId: {
                    ...state.machineListStatusByServerId,
                    'server-b': 'signedOut',
                },
            }));
        });

        await renderScreen(<Probe
                    allowedServerIds={['server-a', 'server-b']}
                    activeServerId="server-a"
                    activeMachines={[createMachine('machine-a')]}
                    onGroups={(groups) => captured.push(groups)}
                />);

        const latest = captured.at(-1) ?? [];
        const remoteGroup = latest.find((group) => group.serverId === 'server-b');
        expect(remoteGroup?.signedOut).toBe(true);
        expect(remoteGroup?.machines).toEqual([]);
    });

    it('filters revoked machines out of all groups', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];

        const activeRevoked = { ...createMachine('machine-a'), revokedAt: 123 } as Machine;
        const remoteRevoked = { ...createMachine('machine-b'), revokedAt: 456 } as Machine;

        act(() => {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-b': [remoteRevoked],
                },
                machineListStatusByServerId: {
                    ...state.machineListStatusByServerId,
                    'server-b': 'idle',
                },
            }));
        });

        await renderScreen(<Probe
                    allowedServerIds={['server-a', 'server-b']}
                    activeServerId="server-a"
                    activeMachines={[activeRevoked]}
                    onGroups={(groups) => captured.push(groups)}
                />);

        const latest = captured.at(-1) ?? [];
        const activeGroup = latest.find((group) => group.serverId === 'server-a');
        const remoteGroup = latest.find((group) => group.serverId === 'server-b');
        expect(activeGroup?.machines).toEqual([]);
        expect(remoteGroup?.machines).toEqual([]);
    });

    it('filters replaced machines out of all groups', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];

        const activeReplaced = {
            ...createMachine('machine-a'),
            replacedByMachineId: 'machine-current',
            replacedAt: 123,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
        } as Machine;
        const remoteReplaced = {
            ...createMachine('machine-b'),
            replacedByMachineId: 'machine-current',
            replacedAt: 456,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
        } as Machine;

        act(() => {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-b': [remoteReplaced],
                },
                machineListStatusByServerId: {
                    ...state.machineListStatusByServerId,
                    'server-b': 'idle',
                },
            }));
        });

        await renderScreen(<Probe
                    allowedServerIds={['server-a', 'server-b']}
                    activeServerId="server-a"
                    activeMachines={[activeReplaced]}
                    onGroups={(groups) => captured.push(groups)}
                />);

        const latest = captured.at(-1) ?? [];
        const activeGroup = latest.find((group) => group.serverId === 'server-a');
        const remoteGroup = latest.find((group) => group.serverId === 'server-b');
        expect(activeGroup?.machines).toEqual([]);
        expect(remoteGroup?.machines).toEqual([]);
    });
});
