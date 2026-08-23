import * as React from 'react';
import { vi } from 'vitest';

import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

import {
    resolveMachineAdministrationTargetState,
    type MachineAdministrationCandidateAvailabilityV1,
    type MachineAdministrationCandidateV1,
} from '@/sync/domains/machines/administration/targetSelection';
import type {
    MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';

/**
 * One machine the mocked Account-portable inventory can offer. `availability`
 * drives both selectability and the presented target state, so a suite can
 * exercise an offline or revoked selection without rebuilding the controller.
 */
export type MachineAdministrationTargetSelectionMockMachine = Readonly<{
    machineId: string;
    displayName?: string;
    availability?: MachineAdministrationCandidateAvailabilityV1;
    observation?: 'live' | 'stale';
    /**
     * Server identity this machine was observed under. Defaults to the mock's
     * own identity, so a suite only names it to reproduce the Account-portable
     * case where two server profiles expose the same machine id.
     */
    serverIdentityId?: string;
    /** Device-local routing id of that identity's profile. */
    serverId?: string;
    /** Presented server label for that identity's profile. */
    serverLabel?: string;
}>;

export type MachineAdministrationTargetSelectionMockOptions = Readonly<{
    serverId?: string;
    serverIdentityId?: string;
    serverLabel?: string;
    machines?: readonly MachineAdministrationTargetSelectionMockMachine[];
    selectedMachineId?: string | null;
    /** Server identity of the selected target; defaults to the mock's identity. */
    selectedServerIdentityId?: string;
}>;

export type MachineAdministrationTargetSelectionMockController = Readonly<{
    /** Persists the exact target a user picked and re-renders every subscriber. */
    select(machineId: string | null, serverIdentityId?: string): void;
    /** Replaces the candidate inventory the selector and callers can see. */
    setMachines(machines: readonly MachineAdministrationTargetSelectionMockMachine[]): void;
    /** Restores the machines and selection the mock was created with. */
    reset(): void;
    readonly serverId: string;
    readonly serverIdentityId: string;
    /** Every `selectTarget` the component tree performed, newest last. */
    readonly selectedTargets: readonly MachineAdministrationTargetV1[];
    /** How many times the component tree cleared the stored preference. */
    readonly clearCount: number;
}>;

type MachineAdministrationTargetSelectionMockModule = Readonly<{
    useMachineAdministrationTargetSelection: (selectionKey: string) => MachineAdministrationTargetSelectionV1;
    resolveFreshMachineAdministrationExecutionTarget: (
        target: MachineAdministrationTargetV1 | null,
    ) => ReturnType<MachineAdministrationTargetSelectionV1['resolveExecutionTarget']>;
}>;

type ResolvedExecutionTarget = ReturnType<MachineAdministrationTargetSelectionV1['resolveExecutionTarget']>;

type MockInventoryRow = MachineAdministrationTargetSelectionV1['pickerRows'][number];

/**
 * Builds the canonical all-profile inventory rows. Each row keeps the full
 * `{ serverIdentityId, machineId }` tuple together with the device-local
 * routing id it was observed from, exactly like the real snapshot projection,
 * so a suite can reproduce one machine id claimed by two server profiles.
 */
function buildInventoryRows(input: Readonly<{
    serverId: string;
    serverIdentityId: string;
    serverLabel: string;
    machines: readonly MachineAdministrationTargetSelectionMockMachine[];
}>): readonly MockInventoryRow[] {
    return input.machines.map((machine) => {
        const rowServerIdentityId = machine.serverIdentityId ?? input.serverIdentityId;
        const rowServerId = machine.serverId
            ?? (rowServerIdentityId === input.serverIdentityId ? input.serverId : rowServerIdentityId);
        const rowServerLabel = machine.serverLabel ?? input.serverLabel;
        const candidate: MachineAdministrationCandidateV1 = {
            target: { serverIdentityId: rowServerIdentityId, machineId: machine.machineId },
            displayName: machine.displayName ?? machine.machineId,
            serverLabel: rowServerLabel,
            availability: machine.availability ?? 'online',
            observation: machine.observation ?? 'live',
            observedAt: 1,
        };
        return {
            candidate,
            serverId: rowServerId,
            serverName: rowServerLabel,
            machine: { id: machine.machineId },
        } as unknown as MockInventoryRow;
    });
}

function resolveExecutionTargetFrom(input: Readonly<{
    rows: readonly MockInventoryRow[];
    target: MachineAdministrationTargetV1 | null;
}>): ResolvedExecutionTarget {
    if (!input.target) return null;
    const row = input.rows.find((entry) => (
        entry.candidate.target.serverIdentityId === input.target!.serverIdentityId
        && entry.candidate.target.machineId === input.target!.machineId
    ));
    const candidate = row?.candidate;
    if (!row || !candidate || candidate.availability !== 'online' || candidate.observation !== 'live') return null;
    return {
        kind: 'resolved',
        target: candidate.target,
        serverId: row.serverId,
        profile: { id: row.serverId, serverIdentityId: candidate.target.serverIdentityId },
        machine: { id: candidate.target.machineId },
    } as unknown as NonNullable<ResolvedExecutionTarget>;
}

/**
 * Static selection snapshot for view-level tests that render a component
 * taking the canonical selection as a prop rather than reading the owner hook.
 */
export function createMachineAdministrationTargetSelectionFixture(
    options: MachineAdministrationTargetSelectionMockOptions = {},
): MachineAdministrationTargetSelectionV1 {
    const serverId = options.serverId ?? 'server-a';
    const serverIdentityId = options.serverIdentityId ?? 'srv_test';
    const machines = options.machines ?? [{ machineId: 'machine-a', displayName: 'Mac' }];
    const rows = buildInventoryRows({
        serverId,
        serverIdentityId,
        serverLabel: options.serverLabel ?? 'Test server',
        machines,
    });
    const candidates = rows.map((row) => row.candidate);
    const selectedMachineId = options.selectedMachineId === undefined
        ? machines[0]?.machineId ?? null
        : options.selectedMachineId;
    const selectedTarget = selectedMachineId === null
        ? null
        : {
            serverIdentityId: options.selectedServerIdentityId ?? serverIdentityId,
            machineId: selectedMachineId,
        };
    const resolve = () => resolveExecutionTargetFrom({ rows, target: selectedTarget });
    return {
        candidates,
        pickerRows: rows,
        state: resolveMachineAdministrationTargetState({
            storedTarget: selectedTarget,
            candidates,
            allowSoleCandidate: true,
        }),
        selectedTarget,
        canExecute: resolve() !== null,
        selectTarget: () => undefined,
        clearTarget: () => undefined,
        resolveExecutionTarget: resolve,
    };
}

/**
 * Replaces the Account-portable Machine Administration selection owner, which
 * reads persisted settings and the live all-profile machine inventory, with a
 * controllable stand-in. Consumers under test keep their real target logic —
 * only the storage/inventory boundary is replaced.
 */
export function createMachineAdministrationTargetSelectionMock(
    options: MachineAdministrationTargetSelectionMockOptions = {},
): Readonly<{
    controller: MachineAdministrationTargetSelectionMockController;
    module: MachineAdministrationTargetSelectionMockModule;
}> {
    const serverId = options.serverId ?? 'server-a';
    const serverIdentityId = options.serverIdentityId ?? 'srv_test';
    const serverLabel = options.serverLabel ?? 'Test server';
    const initialMachines = options.machines ?? [{ machineId: 'machine-a', displayName: 'Mac' }];
    const initialSelected = options.selectedMachineId === undefined
        ? initialMachines[0]?.machineId ?? null
        : options.selectedMachineId;

    const state = {
        machines: [...initialMachines] as readonly MachineAdministrationTargetSelectionMockMachine[],
        selectedMachineId: initialSelected,
        selectedServerIdentityId: options.selectedServerIdentityId ?? serverIdentityId,
        selectedTargets: [] as MachineAdministrationTargetV1[],
        clearCount: 0,
    };
    const listeners = new Set<() => void>();
    const notify = (): void => {
        for (const listener of [...listeners]) listener();
    };

    const currentRows = (): readonly MockInventoryRow[] => buildInventoryRows({
        serverId, serverIdentityId, serverLabel, machines: state.machines,
    });
    const currentTarget = (): MachineAdministrationTargetV1 | null => (
        state.selectedMachineId === null
            ? null
            : {
                serverIdentityId: state.selectedServerIdentityId,
                machineId: state.selectedMachineId,
            }
    );
    const resolve = (target: MachineAdministrationTargetV1 | null): ResolvedExecutionTarget => (
        resolveExecutionTargetFrom({ rows: currentRows(), target })
    );

    // Stable across renders, exactly like the real owner's selection-key-scoped
    // callback, so a consumer keying an execution scope on it is not restarted
    // by every unrelated inventory update.
    const stableResolveExecutionTarget = (): ResolvedExecutionTarget => resolve(currentTarget());

    const controller: MachineAdministrationTargetSelectionMockController = {
        select(machineId, nextServerIdentityId) {
            state.selectedMachineId = machineId;
            state.selectedServerIdentityId = nextServerIdentityId ?? serverIdentityId;
            notify();
        },
        setMachines(machines) {
            state.machines = [...machines];
            notify();
        },
        reset() {
            state.machines = [...initialMachines];
            state.selectedMachineId = initialSelected;
            state.selectedServerIdentityId = options.selectedServerIdentityId ?? serverIdentityId;
            state.selectedTargets.length = 0;
            state.clearCount = 0;
            notify();
        },
        serverId,
        serverIdentityId,
        get selectedTargets() { return state.selectedTargets; },
        get clearCount() { return state.clearCount; },
    };

    const module: MachineAdministrationTargetSelectionMockModule = {
        useMachineAdministrationTargetSelection: () => {
            const [, rerender] = React.useReducer((value: number) => value + 1, 0);
            React.useEffect(() => {
                const listener = () => rerender();
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            }, []);
            const rows = currentRows();
            const candidates = rows.map((row) => row.candidate);
            const target = currentTarget();
            return {
                candidates,
                pickerRows: rows,
                state: resolveMachineAdministrationTargetState({
                    storedTarget: target,
                    candidates,
                    allowSoleCandidate: true,
                }),
                selectedTarget: target,
                canExecute: resolve(target) !== null,
                selectTarget: (next: MachineAdministrationTargetV1) => {
                    state.selectedTargets.push(next);
                    controller.select(next.machineId, next.serverIdentityId);
                },
                clearTarget: () => {
                    state.clearCount += 1;
                    controller.select(null);
                },
                resolveExecutionTarget: stableResolveExecutionTarget,
            };
        },
        resolveFreshMachineAdministrationExecutionTarget: (target) => resolve(target),
    };

    return { controller, module };
}

/**
 * Installs the mocked selection owner plus a pass-through stand-in for the
 * shared selector component, so a screen test can drive the exact selected
 * machine without rendering the full grouped picker.
 */
export function installMachineAdministrationTargetSelectionBoundary(
    mock: Readonly<{ module: MachineAdministrationTargetSelectionMockModule }>,
): void {
    vi.doMock('@/sync/domains/machines/administration/useTargetSelection', () => mock.module);
    vi.doMock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
        MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
            React.createElement('MachineAdministrationTargetSelector', props)
        ),
    }));
}
