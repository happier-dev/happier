import * as React from 'react';
import { vi } from 'vitest';

import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import type {
    MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import {
    buildInventoryRows,
    resolveExecutionTargetFrom,
    type MachineAdministrationTargetSelectionMockMachine,
    type MachineAdministrationTargetSelectionMockOptions,
    type MockInventoryRow,
    type ResolvedExecutionTarget,
} from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';

export type MachineAdministrationTargetSelectionMockController = Readonly<{
    /** Persists the exact target a user picked and re-renders every subscriber. */
    select(machineId: string | null, serverIdentityId?: string): void;
    /** Replaces the candidate inventory the selector and callers can see. */
    setMachines(machines: readonly MachineAdministrationTargetSelectionMockMachine[]): void;
    /**
     * Keeps the selected machine online in the picker while its live connection cannot be resolved
     * yet (the Account's data still loading): `resolveExecutionTarget()` answers `null`.
     */
    setExecutionPending(pending: boolean): void;
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
    useMachineAdministrationTargetSelection: (
        selectionKey: string,
        options?: Readonly<{ initialTarget?: MachineAdministrationTargetV1 | null }>,
    ) => MachineAdministrationTargetSelectionV1;
    useMachineAdministrationTargetPickerRows: () => MachineAdministrationTargetSelectionV1['pickerRows'];
    resolveFreshMachineAdministrationExecutionTarget: (
        target: MachineAdministrationTargetV1 | null,
    ) => ReturnType<MachineAdministrationTargetSelectionV1['resolveExecutionTarget']>;
}>;

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
        executionPending: false,
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
        state.executionPending ? null : resolveExecutionTargetFrom({ rows: currentRows(), target })
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
        setExecutionPending(pending) {
            state.executionPending = pending;
            notify();
        },
        reset() {
            state.executionPending = false;
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
        useMachineAdministrationTargetPickerRows: () => {
            const [, rerender] = React.useReducer((value: number) => value + 1, 0);
            React.useEffect(() => {
                const listener = () => rerender();
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            }, []);
            return currentRows();
        },
        useMachineAdministrationTargetSelection: (_selectionKey, selectionOptions) => {
            const [, rerender] = React.useReducer((value: number) => value + 1, 0);
            React.useEffect(() => {
                const listener = () => rerender();
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            }, []);
            // Like the owner: an explicit navigation target is selected once, when its candidate is known.
            const initialTarget = selectionOptions?.initialTarget ?? null;
            const appliedInitialTargetKey = React.useRef<string | null>(null);
            React.useEffect(() => {
                if (!initialTarget) return;
                const key = `${initialTarget.serverIdentityId}\n${initialTarget.machineId}`;
                if (appliedInitialTargetKey.current === key) return;
                const known = currentRows().some(({ candidate }) => (
                    candidate.target.serverIdentityId === initialTarget.serverIdentityId
                    && candidate.target.machineId === initialTarget.machineId
                ));
                if (!known) return;
                appliedInitialTargetKey.current = key;
                state.selectedTargets.push(initialTarget);
                controller.select(initialTarget.machineId, initialTarget.serverIdentityId);
            });
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
                    isInventoryKnown: () => true,
                }),
                selectedTarget: target,
                selectedTargetServerMatchesActiveAccount: target?.serverIdentityId === serverIdentityId,
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
        // The machine scope as a SelectionList filter: a fixed stand-in chip that still carries the
        // selection and the controlled-open props, so a test can assert what the owner received.
        useMachineAdministrationTargetFilter: (props: Readonly<Record<string, unknown>>) => ({
            id: 'machine',
            label: String(props.groupTitle ?? 'machine'),
            valueLabel: 'machine',
            testID: `${String(props.testIDPrefix ?? 'machine-administration-target')}.chip`,
            ownerProps: props,
        }),
    }));
}
