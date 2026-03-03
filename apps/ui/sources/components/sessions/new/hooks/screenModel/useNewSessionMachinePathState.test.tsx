import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useNewSessionMachinePathState } from './useNewSessionMachinePathState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MachineFixture = {
    id: string;
    metadata?: { homeDir?: string | null };
};

async function flushEffects(turns = 2): Promise<void> {
    for (let i = 0; i < turns; i += 1) {
        await Promise.resolve();
    }
}

describe('useNewSessionMachinePathState', () => {
    it('prefers an online machine from recent paths over an offline one', async () => {
        const snapshots: Array<{ selectedMachineId: string | null; selectedPath: string }> = [];
        const now = Date.now();

        function Probe(props: Readonly<{
            machines: Array<MachineFixture & { activeAt?: number; revokedAt?: number | null }>;
            recentMachinePaths: Array<{ machineId: string; path: string }>;
        }>) {
            const state = useNewSessionMachinePathState({
                machines: props.machines as any,
                recentMachinePaths: props.recentMachinePaths,
                machineIdParam: null,
                pathParam: null,
            });

            React.useEffect(() => {
                snapshots.push({
                    selectedMachineId: state.selectedMachineId,
                    selectedPath: state.selectedPath,
                });
            }, [state.selectedMachineId, state.selectedPath]);

            return null;
        }

        const machines = [
            { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
            { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
        ];

        await act(async () => {
            renderer.create(
                React.createElement(Probe, {
                    machines,
                    recentMachinePaths: [
                        { machineId: 'machine-offline', path: '/repo/offline' },
                        { machineId: 'machine-online', path: '/repo/online' },
                    ],
                }),
            );
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/repo/online',
        });
    });

    it('falls back to an online machine when the requested route machine is offline', async () => {
        const snapshots: Array<{ selectedMachineId: string | null; selectedPath: string }> = [];
        const now = Date.now();

        function Probe(props: Readonly<{
            machines: Array<MachineFixture & { activeAt?: number; revokedAt?: number | null }>;
            machineIdParam: string | null;
        }>) {
            const state = useNewSessionMachinePathState({
                machines: props.machines as any,
                recentMachinePaths: [],
                machineIdParam: props.machineIdParam,
                pathParam: null,
            });

            React.useEffect(() => {
                snapshots.push({
                    selectedMachineId: state.selectedMachineId,
                    selectedPath: state.selectedPath,
                });
            }, [state.selectedMachineId, state.selectedPath]);

            return null;
        }

        const machines = [
            { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
            { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
        ];

        await act(async () => {
            renderer.create(
                React.createElement(Probe, {
                    machines,
                    machineIdParam: 'machine-offline',
                }),
            );
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/online',
        });
    });

    it('reselects a valid machine when the currently selected machine disappears', async () => {
        const snapshots: Array<{ selectedMachineId: string | null; selectedPath: string }> = [];

        function Probe(props: Readonly<{
            machines: MachineFixture[];
            recentMachinePaths: Array<{ machineId: string; path: string }>;
        }>) {
            const state = useNewSessionMachinePathState({
                machines: props.machines as any,
                recentMachinePaths: props.recentMachinePaths,
                machineIdParam: null,
                pathParam: null,
            });

            React.useEffect(() => {
                snapshots.push({
                    selectedMachineId: state.selectedMachineId,
                    selectedPath: state.selectedPath,
                });
            }, [state.selectedMachineId, state.selectedPath]);

            return null;
        }

        const initialMachines: MachineFixture[] = [
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' } },
        ];
        const replacementMachines: MachineFixture[] = [
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' } },
        ];

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(Probe, {
                    machines: initialMachines,
                    recentMachinePaths: [{ machineId: 'machine-old', path: '/repo/old' }],
                }),
            );
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await act(async () => {
            tree?.update(
                React.createElement(Probe, {
                    machines: replacementMachines,
                    recentMachinePaths: [{ machineId: 'machine-new', path: '/repo/new' }],
                }),
            );
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-new',
            selectedPath: '/repo/new',
        });

        await act(async () => {
            tree?.unmount();
            await flushEffects(2);
        });
    });
});
