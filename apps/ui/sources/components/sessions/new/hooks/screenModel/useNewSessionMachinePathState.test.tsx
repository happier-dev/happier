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

    it('preserves the requested route machine when it is offline but still available', async () => {
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
            selectedMachineId: 'machine-offline',
            selectedPath: '/offline',
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

    it('preserves the current selection when it becomes offline but still exists', async () => {
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

        const initialMachines = [
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' }, activeAt: now - 5_000 },
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' }, activeAt: now - 10_000 },
        ];
        const updatedMachines = [
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' }, activeAt: now - 5 * 60_000 },
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' }, activeAt: now - 10_000 },
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
                    machines: updatedMachines,
                    recentMachinePaths: [
                        { machineId: 'machine-old', path: '/repo/old' },
                        { machineId: 'machine-new', path: '/repo/new' },
                    ],
                }),
            );
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await act(async () => {
            tree?.unmount();
            await flushEffects(2);
        });
    });

    it('does not reapply a stale route path after the user switches to another linked worktree path', async () => {
        const snapshots: Array<{ selectedMachineId: string | null; selectedPath: string }> = [];
        const stateRef: { current: ReturnType<typeof useNewSessionMachinePathState> | null } = { current: null };

        function Probe(props: Readonly<{
            pathParam: string | null;
        }>) {
            const state = useNewSessionMachinePathState({
                machines: [{ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }] as any,
                recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/custom' }],
                machineIdParam: 'machine-1',
                pathParam: props.pathParam,
            });

            stateRef.current = state;

            React.useEffect(() => {
                snapshots.push({
                    selectedMachineId: state.selectedMachineId,
                    selectedPath: state.selectedPath,
                });
            }, [state.selectedMachineId, state.selectedPath]);

            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Probe, {
                pathParam: '/repo/custom',
            }));
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/custom',
        });
        expect(typeof stateRef.current?.setSelectedPath).toBe('function');

        await act(async () => {
            stateRef.current?.setSelectedPath('/repo/release');
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/release',
        });

        await act(async () => {
            tree?.update(React.createElement(Probe, {
                pathParam: '/repo/custom',
            }));
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/release',
        });

        await act(async () => {
            tree?.update(React.createElement(Probe, {
                pathParam: '/repo/hotfix',
            }));
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/hotfix',
        });

        await act(async () => {
            tree?.unmount();
            await flushEffects(2);
        });
    });

    it('accepts string-array machine and path route params from expo-router search state', async () => {
        const snapshots: Array<{ selectedMachineId: string | null; selectedPath: string }> = [];

        function Probe() {
            const state = useNewSessionMachinePathState({
                machines: [{ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }] as any,
                recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/recent' }],
                machineIdParam: ['machine-1'],
                pathParam: ['/repo/custom'],
            });

            React.useEffect(() => {
                snapshots.push({
                    selectedMachineId: state.selectedMachineId,
                    selectedPath: state.selectedPath,
                });
            }, [state.selectedMachineId, state.selectedPath]);

            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/custom',
        });
    });

    it('backfills an empty seeded path once the selected machine home directory becomes available', async () => {
        const snapshots: Array<{ selectedMachineId: string | null; selectedPath: string }> = [];

        function Probe(props: Readonly<{
            machines: MachineFixture[];
        }>) {
            const state = useNewSessionMachinePathState({
                machines: props.machines as any,
                recentMachinePaths: [],
                machineIdParam: 'machine-1',
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Probe, {
                machines: [{ id: 'machine-1', metadata: { homeDir: null } }],
            }));
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });

        await act(async () => {
            tree?.update(React.createElement(Probe, {
                machines: [{ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }],
            }));
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/Users/leeroy',
        });
    });

    it('does not clobber an explicit user-cleared path when machine metadata refreshes', async () => {
        const snapshots: Array<{ selectedMachineId: string | null; selectedPath: string }> = [];
        const stateRef: { current: ReturnType<typeof useNewSessionMachinePathState> | null } = { current: null };

        function Probe(props: Readonly<{
            machines: MachineFixture[];
        }>) {
            const state = useNewSessionMachinePathState({
                machines: props.machines as any,
                recentMachinePaths: [],
                machineIdParam: 'machine-1',
                pathParam: null,
            });

            stateRef.current = state;
            React.useEffect(() => {
                snapshots.push({
                    selectedMachineId: state.selectedMachineId,
                    selectedPath: state.selectedPath,
                });
            }, [state.selectedMachineId, state.selectedPath]);

            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Probe, {
                machines: [{ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }],
            }));
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/Users/leeroy',
        });

        await act(async () => {
            stateRef.current?.setSelectedPath('');
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });

        await act(async () => {
            tree?.update(React.createElement(Probe, {
                machines: [{ id: 'machine-1', metadata: { homeDir: '/Users/leeroy/updated' } }],
            }));
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });
    });

    it('reapplies the route directory after the requested machine hydrates later', async () => {
        const snapshots: Array<{ selectedMachineId: string | null; selectedPath: string }> = [];

        function Probe(props: Readonly<{
            machines: MachineFixture[];
            machineIdParam: string;
            pathParam: string;
        }>) {
            const state = useNewSessionMachinePathState({
                machines: props.machines as any,
                recentMachinePaths: [],
                machineIdParam: props.machineIdParam,
                pathParam: props.pathParam,
            });

            React.useEffect(() => {
                snapshots.push({
                    selectedMachineId: state.selectedMachineId,
                    selectedPath: state.selectedPath,
                });
            }, [state.selectedMachineId, state.selectedPath]);

            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(Probe, {
                    machines: [],
                    machineIdParam: 'machine-a',
                    pathParam: '/repo',
                }),
            );
            await flushEffects(4);
        });

        await act(async () => {
            tree?.update(
                React.createElement(Probe, {
                    machines: [{ id: 'machine-a', metadata: { homeDir: '/Users/leeroy' } }],
                    machineIdParam: 'machine-a',
                    pathParam: '/repo',
                }),
            );
            await flushEffects(4);
        });

        expect(snapshots.at(-1)).toEqual({
            selectedMachineId: 'machine-a',
            selectedPath: '/repo',
        });

        await act(async () => {
            tree?.unmount();
            await flushEffects(2);
        });
    });
});
