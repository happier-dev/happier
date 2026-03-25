import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { createMachineFixture, renderHook } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { useNewSessionMachinePathState } from './useNewSessionMachinePathState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MachineFixtureInput = {
    id: string;
    metadata?: Partial<NonNullable<Machine['metadata']>> | null;
    active?: boolean;
    activeAt?: number;
    revokedAt?: number | null;
};

type HookState = ReturnType<typeof useNewSessionMachinePathState>;
type HookParams = Parameters<typeof useNewSessionMachinePathState>[0];

function makeMachine({ id, metadata, ...overrides }: MachineFixtureInput): Machine {
    const base = createMachineFixture({ id, ...overrides });
    // These tests intentionally model partially hydrated machine metadata.
    const mergedMetadata = metadata === undefined
        ? base.metadata
        : metadata === null
            ? null
            : {
                ...(base.metadata ?? {}),
                ...metadata,
            } as NonNullable<Machine['metadata']>;
    return {
        ...base,
        ...overrides,
        id,
        metadata: mergedMetadata,
    };
}

function toMachines(...machines: MachineFixtureInput[]): HookParams['machines'] {
    return machines.map(makeMachine);
}

function getSelection(state: HookState): Readonly<{
    selectedMachineId: string | null;
    selectedPath: string;
}> {
    return {
        selectedMachineId: state.selectedMachineId,
        selectedPath: state.selectedPath,
    };
}

function renderMachinePathState(initialProps: HookParams) {
    return renderHook((props: HookParams) => useNewSessionMachinePathState(props), {
        initialProps,
    });
}

describe('useNewSessionMachinePathState', () => {
    it('treats machines as eligible for initial selection when they are online via activeAt even if active=false', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-stale-active', metadata: { homeDir: '/stale' }, active: true, activeAt: now - 3 * 60_000 },
                // Real server snapshots can report recent activeAt while leaving `active` false.
                { id: 'machine-online', metadata: { homeDir: '/online' }, active: false, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [
                { machineId: 'machine-stale-active', path: '/repo/stale' },
                { machineId: 'machine-online', path: '/repo/online' },
            ],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/repo/online',
        });

        await hook.unmount();
    });

    it('prefers an online machine from recent paths over an offline one', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [
                { machineId: 'machine-offline', path: '/repo/offline' },
                { machineId: 'machine-online', path: '/repo/online' },
            ],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/repo/online',
        });

        await hook.unmount();
    });

    it('preserves the requested route machine when it is offline but still available', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [],
            machineIdParam: 'machine-offline',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-offline',
            selectedPath: '/offline',
        });

        await hook.unmount();
    });

    it('reselects a valid machine when the currently selected machine disappears', async () => {
        const initialMachines: MachineFixtureInput[] = [
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' } },
        ];
        const replacementMachines: MachineFixtureInput[] = [
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' } },
        ];

        const hook = await renderMachinePathState({
            machines: toMachines(...initialMachines),
            recentMachinePaths: [{ machineId: 'machine-old', path: '/repo/old' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await hook.rerender({
            machines: toMachines(...replacementMachines),
            recentMachinePaths: [{ machineId: 'machine-new', path: '/repo/new' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-new',
            selectedPath: '/repo/new',
        });

        await hook.unmount();
    });

    it('preserves the current selection when it becomes offline but still exists', async () => {
        const now = Date.now();
        const initialMachines = toMachines(
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' }, activeAt: now - 5_000 },
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' }, activeAt: now - 10_000 },
        );
        const updatedMachines = toMachines(
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' }, activeAt: now - 5 * 60_000 },
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' }, activeAt: now - 10_000 },
        );

        const hook = await renderMachinePathState({
            machines: initialMachines,
            recentMachinePaths: [{ machineId: 'machine-old', path: '/repo/old' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await hook.rerender({
            machines: updatedMachines,
            recentMachinePaths: [
                { machineId: 'machine-old', path: '/repo/old' },
                { machineId: 'machine-new', path: '/repo/new' },
            ],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await hook.unmount();
    });

    it('does not reapply a stale route path after the user switches to another linked worktree path', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/custom' }],
            machineIdParam: 'machine-1',
            pathParam: '/repo/custom',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/custom',
        });
        expect(typeof hook.getCurrent().setSelectedPath).toBe('function');

        await act(async () => {
            hook.getCurrent().setSelectedPath('/repo/release');
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/release',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/custom' }],
            machineIdParam: 'machine-1',
            pathParam: '/repo/custom',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/release',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/custom' }],
            machineIdParam: 'machine-1',
            pathParam: '/repo/hotfix',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/hotfix',
        });

        await hook.unmount();
    });

    it('accepts string-array machine and path route params from expo-router search state', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/recent' }],
            machineIdParam: ['machine-1'],
            pathParam: ['/repo/custom'],
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/custom',
        });

        await hook.unmount();
    });

    it('does not reapply an unchanged machine param after the user selects another available machine', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [],
            machineIdParam: 'machine-offline',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-offline',
            selectedPath: '/offline',
        });

        await act(async () => {
            hook.getCurrent().setSelectedMachineId('machine-online');
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/offline',
        });

        await hook.rerender({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [],
            machineIdParam: 'machine-offline',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/offline',
        });

        await hook.rerender({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [],
            machineIdParam: 'machine-offline-next',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/offline',
        });

        await hook.unmount();
    });

    it('backfills an empty seeded path once the selected machine home directory becomes available', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: undefined } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-1',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-1',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/Users/leeroy',
        });

        await hook.unmount();
    });

    it('does not clobber an explicit user-cleared path when machine metadata refreshes', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-1',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/Users/leeroy',
        });

        await act(async () => {
            hook.getCurrent().setSelectedPath('');
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy/updated' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-1',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });

        await hook.unmount();
    });

    it('reapplies the route directory after the requested machine hydrates later', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines(),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: '/repo',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: '/repo',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-a',
            selectedPath: '/repo',
        });

        await hook.unmount();
    });
});
