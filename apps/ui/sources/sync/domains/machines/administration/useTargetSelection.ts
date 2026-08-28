import * as React from 'react';
import type {
    MachineAdministrationSelectionsV1,
    MachineAdministrationTargetV1,
} from '@happier-dev/protocol';

import {
    areServerProfileIdentifiersEquivalent,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import {
    resolvePortableMachineAdministrationTarget,
    type PortableMachineAdministrationTargetResolution,
} from '@/sync/domains/machines/resolveServerScopedMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import {
    useSetting,
    useActiveServerAccountScope,
} from '@/sync/store/hooks';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    clearMachineAdministrationTargetPreference,
    persistMachineAdministrationSelectionMutation,
    setMachineAdministrationTargetPreference,
} from './selectionPreferences';
import {
    isMachineAdministrationCandidateSelectable,
    resolveMachineAdministrationTargetState,
    type MachineAdministrationCandidateV1,
    type MachineAdministrationTargetStateV1,
} from './targetSelection';
import {
    buildMachineAdministrationCandidateInventoryRowsFromSnapshots,
    buildMachineAdministrationCandidatesFromSnapshots,
    type MachineAdministrationCandidateInventoryRowV1,
} from './targetState';

export type FreshMachineAdministrationExecutionTargetV1 = Extract<
    PortableMachineAdministrationTargetResolution<Machine>,
    { kind: 'resolved' }
>;

/**
 * Presentation-only row for the incumbent grouped selector. The row remains
 * derived from the canonical snapshot owner; its local server id is never a
 * persisted preference or execution authority.
 */
export type MachineAdministrationTargetPickerRowV1 =
    MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>;

export function doesMachineAdministrationTargetMatchActiveAccount(params: Readonly<{
    target: MachineAdministrationTargetV1 | null;
    activeAccountServerId: string | null | undefined;
}>): boolean {
    const activeAccountServerId = String(params.activeAccountServerId ?? '').trim();
    return params.target !== null
        && activeAccountServerId.length > 0
        && areServerProfileIdentifiersEquivalent(
            params.target.serverIdentityId,
            activeAccountServerId,
        );
}

function areAllProfileInventoriesKnown(snapshots: readonly ServerMachineInventorySnapshotV1[]): boolean {
    return snapshots.every((snapshot) => snapshot.kind === 'resolved');
}

function hasLiveExactInventoryRow(params: Readonly<{
    activeServerId: string;
    isDataReady: boolean;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
    resolution: FreshMachineAdministrationExecutionTargetV1;
}>): boolean {
    const { profile, machine } = params.resolution;
    if (areServerProfileIdentifiersEquivalent(profile.id, params.activeServerId)) {
        return params.isDataReady
            && params.activeMachines.some((candidate) => candidate === machine);
    }
    const keys = [
        params.resolution.target.serverIdentityId,
        profile.id,
        profile.serverIdentityId,
        ...(profile.legacyServerIds ?? []),
    ].filter((value, index, values): value is string => (
        typeof value === 'string'
        && value.trim().length > 0
        && values.indexOf(value) === index
    ));
    return keys.some((serverId) => (
        params.machineListStatusByServerId[serverId] === 'idle'
        && params.machineListByServerId[serverId]?.some((candidate) => candidate === machine) === true
    ));
}

/**
 * Re-resolves the Account-portable preference from current raw owner state.
 * Warm-cache rows never enter this path, and availability is checked again at
 * invocation time so a presentation snapshot cannot authorize a later effect.
 */
export function resolveFreshMachineAdministrationExecutionTarget(
    target: MachineAdministrationTargetV1 | null,
): FreshMachineAdministrationExecutionTargetV1 | null {
    if (!target) return null;
    const state = storage.getState();
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const machineListByServerId = state.machineListByServerId ?? {};
    const activeMachines = state.isDataReady ? Object.values(state.machines ?? {}) : [];
    const resolution = resolvePortableMachineAdministrationTarget({
        target,
        activeServerId,
        activeMachines,
        machineListByServerId,
    });
    if (resolution.kind !== 'resolved') return null;
    if (!hasLiveExactInventoryRow({
        activeServerId,
        isDataReady: state.isDataReady === true,
        activeMachines,
        machineListByServerId,
        machineListStatusByServerId: state.machineListStatusByServerId ?? {},
        resolution,
    })) {
        return null;
    }
    if (resolution.machine.availability?.kind === 'locked') return null;
    return resolveMachinePickerPresence(resolution.machine).status === 'online' ? resolution : null;
}

export type MachineAdministrationTargetSelectionV1 = Readonly<{
    candidates: readonly MachineAdministrationCandidateV1[];
    pickerRows: readonly MachineAdministrationTargetPickerRowV1[];
    state: MachineAdministrationTargetStateV1;
    selectedTarget: MachineAdministrationTargetV1 | null;
    /**
     * Whether Account-owned settings may be composed with the selected
     * target. Daemon inspection can still address a foreign server, but
     * Account settings, groups, quotas, and Saved Secrets must fail closed.
     */
    selectedTargetServerMatchesActiveAccount: boolean;
    canExecute: boolean;
    selectTarget: (target: MachineAdministrationTargetV1) => void;
    clearTarget: () => void;
    resolveExecutionTarget: () => FreshMachineAdministrationExecutionTargetV1 | null;
}>;

export type MachineAdministrationTargetSelectionOptions = Readonly<{
    /**
     * Most administration screens may initialize a sole verified machine.
     * Consumers whose catalog depends on an explicit machine scope opt out so
     * they never imply account-wide availability from one observed daemon.
     */
    allowSoleCandidate?: boolean;
}>;

/**
 * Administration's Account-level exact target controller. It consumes the raw
 * all-profile machine producer plus its presentation-only warm fallback; it
 * never derives authority from launch lists, active-machine heuristics, or row
 * order.
 */
export function useMachineAdministrationTargetSelection(
    selectionKey: string,
    options: MachineAdministrationTargetSelectionOptions = {},
): MachineAdministrationTargetSelectionV1 {
    const selections = useSetting('machineAdministrationSelectionsV1');
    const activeAccountScope = useActiveServerAccountScope();
    const storedTarget = selections.targetsByKey[selectionKey] ?? null;
    const selectedTargetServerMatchesActiveAccount = doesMachineAdministrationTargetMatchActiveAccount({
        target: storedTarget,
        activeAccountServerId: activeAccountScope?.serverId,
    });
    const snapshots = useAllProfileMachineInventorySnapshots();
    const candidates = React.useMemo(
        () => buildMachineAdministrationCandidatesFromSnapshots({ snapshots }),
        [snapshots],
    );
    const pickerRows = React.useMemo(
        () => buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots }),
        [snapshots],
    );
    const allowSoleCandidate = areAllProfileInventoriesKnown(snapshots)
        && options.allowSoleCandidate !== false;
    const targetState = React.useMemo(() => resolveMachineAdministrationTargetState({
        storedTarget,
        candidates,
        allowSoleCandidate,
    }), [allowSoleCandidate, candidates, storedTarget]);

    React.useEffect(() => {
        if (storedTarget || !allowSoleCandidate || targetState.kind !== 'online') return;
        fireAndForget(persistMachineAdministrationSelectionMutation((current) => (
            setMachineAdministrationTargetPreference(current, selectionKey, targetState.target)
        )), { tag: 'useMachineAdministrationTargetSelection.initialize' });
    }, [allowSoleCandidate, selectionKey, storedTarget, targetState]);

    const selectTarget = React.useCallback((target: MachineAdministrationTargetV1) => {
        const candidate = candidates.find((item) => (
            item.target.serverIdentityId === target.serverIdentityId
            && item.target.machineId === target.machineId
        ));
        if (!candidate || !isMachineAdministrationCandidateSelectable(candidate)) return;
        fireAndForget(persistMachineAdministrationSelectionMutation((current) => (
            setMachineAdministrationTargetPreference(current, selectionKey, candidate.target)
        )), { tag: 'useMachineAdministrationTargetSelection.select' });
    }, [candidates, selectionKey]);

    const clearTarget = React.useCallback(() => {
        fireAndForget(persistMachineAdministrationSelectionMutation((current) => (
            clearMachineAdministrationTargetPreference(current, selectionKey)
        )), { tag: 'useMachineAdministrationTargetSelection.clear' });
    }, [selectionKey]);

    const resolveExecutionTarget = React.useCallback(
        () => resolveFreshMachineAdministrationExecutionTarget(
            storage.getState().settings.machineAdministrationSelectionsV1.targetsByKey[selectionKey] ?? null,
        ),
        [selectionKey],
    );

    return React.useMemo(() => ({
        candidates,
        pickerRows,
        state: targetState,
        selectedTarget: storedTarget,
        selectedTargetServerMatchesActiveAccount,
        canExecute: resolveFreshMachineAdministrationExecutionTarget(storedTarget) !== null,
        selectTarget,
        clearTarget,
        resolveExecutionTarget,
    }), [
        candidates,
        clearTarget,
        pickerRows,
        resolveExecutionTarget,
        selectTarget,
        selectedTargetServerMatchesActiveAccount,
        storedTarget,
        targetState,
    ]);
}
