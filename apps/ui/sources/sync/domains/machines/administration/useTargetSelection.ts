import * as React from 'react';
import type {
    MachineAdministrationTargetV1,
} from '@happier-dev/protocol';

import {
    areServerProfileIdentifiersEquivalent,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { readMachineInventoryStatus, type ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
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
import { useApplySettings, useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';

import {
    clearMachineAdministrationTargetPreference,
    setMachineAdministrationTargetPreference,
} from './selectionPreferences';
import {
    isMachineAdministrationCandidateExplicitlySelectable,
    resolveMachineAdministrationTargetState,
    type MachineAdministrationExplicitSelectionPolicy,
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
> & Readonly<{
    /** UI-local fence for selection changes, including A -> B -> A. */
    selectionRevision?: number;
}>;

type MachineAdministrationSelectionRevisionState = Readonly<{
    selectionKey: string;
    target: MachineAdministrationTargetV1 | null;
    revision: number;
}>;

export function advanceMachineAdministrationSelectionRevision(
    previous: MachineAdministrationSelectionRevisionState,
    selectionKey: string,
    target: MachineAdministrationTargetV1 | null,
): MachineAdministrationSelectionRevisionState {
    const unchanged = previous.selectionKey === selectionKey
        && previous.target?.serverIdentityId === target?.serverIdentityId
        && previous.target?.machineId === target?.machineId;
    return unchanged
        ? previous
        : Object.freeze({ selectionKey, target, revision: previous.revision + 1 });
}

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

/** Whether the Home with this portable identity has answered with its machine list. */
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
 * Re-resolves the device preference from current raw owner state.
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
        machineListStatusByServerId: state.machineListStatusByServerId,
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
    /** Defer detailed inventory and execution while the consuming surface is idle. */
    enabled?: boolean;
    /**
     * Permit initial target selection: a sole verified machine for ordinary
     * scopes, or a live online machine in the Account Home for Plugins.
     * Consumers that require a person's explicit choice opt out.
     */
    allowSoleCandidate?: boolean;
    /**
     * Which machines an explicit choice may name (default `live`). Consumers that show a machine's
     * last known state and disable its operations while it is away pass `lastKnown`. Automatic
     * initialization still takes only live online candidates.
     */
    explicitSelection?: MachineAdministrationExplicitSelectionPolicy;
}>;

/** Presentation-only canonical Administration rows, without creating a persisted selection. */
export function useMachineAdministrationTargetPickerRows(): readonly MachineAdministrationTargetPickerRowV1[] {
    const snapshots = useAllProfileMachineInventorySnapshots();
    return React.useMemo(
        () => buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots }),
        [snapshots],
    );
}

/**
 * Administration's device-local exact target controller. It consumes the raw
 * all-profile machine producer plus its presentation-only warm fallback; it
 * never derives authority from launch lists or presentation row order.
 */
export function useMachineAdministrationTargetSelection(
    selectionKey: string,
    options: MachineAdministrationTargetSelectionOptions = {},
): MachineAdministrationTargetSelectionV1 {
    const enabled = options.enabled !== false;
    const explicitSelection = options.explicitSelection ?? 'live';
    const selections = useSetting('machineAdministrationTargetsLocalV1');
    const applySettings = useApplySettings();
    const expectedSettingsScope = useAccountSettingsScope();
    const activeAccountScope = useActiveServerAccountScope();
    const storedTarget = selections[selectionKey] ?? null;
    const selectionRevisionRef = React.useRef<MachineAdministrationSelectionRevisionState>({
        selectionKey,
        target: storedTarget,
        revision: 0,
    });
    selectionRevisionRef.current = advanceMachineAdministrationSelectionRevision(
        selectionRevisionRef.current,
        selectionKey,
        storedTarget,
    );
    const selectedTargetServerMatchesActiveAccount = doesMachineAdministrationTargetMatchActiveAccount({
        target: storedTarget,
        activeAccountServerId: activeAccountScope?.serverId,
    });
    const snapshots = useAllProfileMachineInventorySnapshots(enabled);
    const candidates = React.useMemo(
        () => buildMachineAdministrationCandidatesFromSnapshots({ snapshots }),
        [snapshots],
    );
    const pickerRows = React.useMemo(
        () => buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots }),
        [snapshots],
    );
    const allowSoleCandidate = enabled && areAllProfileInventoriesKnown(snapshots)
        && options.allowSoleCandidate !== false;
    const targetState = React.useMemo(() => resolveMachineAdministrationTargetState({
        storedTarget,
        candidates,
        allowSoleCandidate,
        readInventoryStatus: (serverIdentityId) => readMachineInventoryStatus(snapshots, serverIdentityId),
    }), [allowSoleCandidate, candidates, snapshots, storedTarget]);

    React.useEffect(() => {
        if (storedTarget || !allowSoleCandidate || targetState.kind !== 'online') return;
        const current = storage.getState();
        if (!expectedSettingsScope || !areAccountSettingsScopesEqual(expectedSettingsScope, current.settingsScope)) return;
        if (current.settings.machineAdministrationTargetsLocalV1[selectionKey]) return;
        // Initial-target memory is local; mounting a route never mutates Account policy.
        applySettings({ machineAdministrationTargetsLocalV1: setMachineAdministrationTargetPreference(
            current.settings.machineAdministrationTargetsLocalV1, selectionKey, targetState.target,
        ) });
    }, [allowSoleCandidate, applySettings, expectedSettingsScope, selectionKey, storedTarget, targetState]);

    const selectTarget = React.useCallback((target: MachineAdministrationTargetV1) => {
        const candidate = candidates.find((item) => (
            item.target.serverIdentityId === target.serverIdentityId
            && item.target.machineId === target.machineId
        ));
        if (!candidate || !isMachineAdministrationCandidateExplicitlySelectable(candidate, explicitSelection)) return;
        const current = storage.getState();
        if (!expectedSettingsScope || !areAccountSettingsScopesEqual(expectedSettingsScope, current.settingsScope)) return;
        applySettings({ machineAdministrationTargetsLocalV1: setMachineAdministrationTargetPreference(
            current.settings.machineAdministrationTargetsLocalV1, selectionKey, candidate.target,
        ) });
    }, [applySettings, candidates, expectedSettingsScope, explicitSelection, selectionKey]);

    const clearTarget = React.useCallback(() => {
        const current = storage.getState();
        if (!expectedSettingsScope || !areAccountSettingsScopesEqual(expectedSettingsScope, current.settingsScope)) return;
        applySettings({ machineAdministrationTargetsLocalV1: clearMachineAdministrationTargetPreference(
            current.settings.machineAdministrationTargetsLocalV1, selectionKey,
        ) });
    }, [applySettings, expectedSettingsScope, selectionKey]);

    const resolveExecutionTarget = React.useCallback(() => {
        if (!enabled) return null;
        const target = storage.getState().settings.machineAdministrationTargetsLocalV1[selectionKey] ?? null;
        selectionRevisionRef.current = advanceMachineAdministrationSelectionRevision(
            selectionRevisionRef.current,
            selectionKey,
            target,
        );
        const resolved = resolveFreshMachineAdministrationExecutionTarget(target);
        return resolved === null
            ? null
            : Object.freeze({
                ...resolved,
                selectionRevision: selectionRevisionRef.current.revision,
            });
    }, [enabled, selectionKey]);

    return React.useMemo(() => ({
        candidates,
        pickerRows,
        state: targetState,
        selectedTarget: storedTarget,
        selectedTargetServerMatchesActiveAccount,
        canExecute: enabled && resolveFreshMachineAdministrationExecutionTarget(storedTarget) !== null,
        selectTarget,
        clearTarget,
        resolveExecutionTarget,
    }), [
        enabled,
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
