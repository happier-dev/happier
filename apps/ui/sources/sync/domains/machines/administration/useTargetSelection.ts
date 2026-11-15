import * as React from 'react';
import type {
    MachineAdministrationTargetV1,
} from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import {
    areServerProfileIdentifiersEquivalent,
} from '@/sync/domains/server/serverProfiles';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { readMachineInventoryStatus } from '@/sync/domains/machines/machineInventorySnapshots';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { resolveFleetMachineAvailability } from './fleetUnion';
import {
    type PortableMachineAdministrationTargetResolution,
} from '@/sync/domains/machines/resolveServerScopedMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import {
    useSetting,
    useActiveServerAccountScope,
} from '@/sync/store/hooks';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readMachineAdministrationTargetObservation,
    rememberMachineAdministrationTargetObservation, useMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';

import {
    areMachineAdministrationInventoriesKnown,
    isMachineAdministrationCandidateExplicitlySelectable,
    resolveMachineAdministrationTargetState,
    type MachineAdministrationExplicitSelectionPolicy,
    type MachineAdministrationCandidateV1,
    type MachineAdministrationTargetStateV1,
} from './targetSelection';
import {
    buildMachineAdministrationCandidateInventoryRowsFromSnapshots,
    buildMachineAdministrationTargetPickerRows,
    MACHINE_ADMINISTRATION_AUTOMATIC_CHOICE_DEMAND,
    readMachineAdministrationTargetFacts,
    type MachineAdministrationCandidateInventoryRowV1,
} from './targetState';
import { resolveFreshMachineAdministrationExecutionTarget } from './executionTarget';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, readMachineAdministrationTargetPreference, readSelectedMachineAdministrationTarget } from './selectionPreferences';
export { resolveFreshMachineAdministrationExecutionTarget } from './executionTarget';

export type MachineAdministrationExecutionTargetOptions = Readonly<{
    intent?: 'retry';
    accountScope?: MachineReachabilityScope | null;
}>;

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

export type MachineAdministrationTargetSelectionV1 = Readonly<{
    /** Draft fields stay in their editor; scope changes may leave unsaved work. */
    changeIntent?: 'scope' | 'draft';
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
    resolveExecutionTarget: (options?: MachineAdministrationExecutionTargetOptions) => FreshMachineAdministrationExecutionTargetV1 | null;
}>;

export type MachineAdministrationTargetSelectionOptions = Readonly<{
    /** Account-owned input keeps both machine choices and execution in its original Home/Account. */
    accountScope?: ServerAccountScope;
    /** Explicit navigation intent. Unknown targets stay selected and unavailable until admitted. */
    initialTarget?: MachineAdministrationTargetV1 | null;
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
    /**
     * Which inventory rows this consumer reads (default `choices`). A consumer that only acts on
     * the stored choice passes `selected`: once a target is stored, only that Machine's labels and
     * eligibility are read, so the rest of the fleet does no work here. Its `candidates` and
     * `pickerRows` then hold that one row and `selectTarget` cannot name another Machine; the
     * chooser that renders the choices mounts its own `choices` selection.
     */
    rows?: 'choices' | 'selected';
}>;

/** Consume the existing choice without mounting a picker or demanding its inventory. */
export function useMachineAdministrationSelectedTarget(selectionKey: string): MachineAdministrationTargetV1 | null {
    const selections = useSetting('machineAdministrationTargetsLocalV1');
    const scope = useAccountSettingsScope();
    const observed = useMachineAdministrationTargetObservation(scope, selectionKey);
    return readSelectedMachineAdministrationTarget(selections, selectionKey, observed);
}

/** Presentation-only canonical Administration rows, without creating a persisted selection. */
export function useMachineAdministrationTargetPickerRows(): readonly MachineAdministrationTargetPickerRowV1[] {
    return useMachineAdministrationTargetRows().pickerRows;
}

/** Retained identities and selectable choices share one inventory projection and explicit resource demand. */
export function useMachineAdministrationTargetRows(options?: Readonly<{
    accountScope?: ServerAccountScope;
    selectedMachineId?: string;
    managedInventoryDemand?: boolean;
}>): Readonly<{
    inventoryRows: readonly MachineAdministrationTargetPickerRowV1[];
    pickerRows: readonly MachineAdministrationTargetPickerRowV1[];
}> {
    const selection = React.useMemo(() => options?.accountScope
        ? { scope: options.accountScope, machineId: null } : undefined,
    [options?.accountScope?.serverId, options?.accountScope?.accountId]);
    // A closed named scope keeps its initial choices, but only its selected
    // record's facts can change its presentation. Opening reads the full chooser.
    const selectedMachineId = options?.selectedMachineId;
    const selectFacts = React.useCallback<typeof readMachineAdministrationTargetFacts>((machine, scope, nowMs) =>
        selectedMachineId && machine.id !== selectedMachineId ? [machine.id]
            : readMachineAdministrationTargetFacts(machine, scope, nowMs), [selectedMachineId]);
    const snapshots = useAllProfileMachineInventorySnapshots(true, selection, options ? selectFacts : undefined);
    const inventoryRows = useMachineAdministrationInventoryRows(snapshots, options?.managedInventoryDemand !== false);
    const pickerRows = React.useMemo(() => buildMachineAdministrationTargetPickerRows(inventoryRows), [inventoryRows]);
    return React.useMemo(() => ({ inventoryRows, pickerRows }), [inventoryRows, pickerRows]);
}

const NO_PRESENCE_TARGETS: readonly Readonly<{ serverId: string; machineIds: readonly string[] }>[] = Object.freeze([]);

/** Inventory owns content; the shared presence owner advances only changed availability facts. */
function useMachineAdministrationInventoryRows(snapshots: readonly ServerMachineInventorySnapshotV1[], managedInventoryDemand = true,
    livePresence = true): readonly MachineAdministrationTargetPickerRowV1[] {
    // Keep the resource receipt demanded even when its last choice disappears.
    // The shared list borrows this same loader; it does not issue another census.
    const managedHomes = React.useMemo(() => managedInventoryDemand
        ? snapshots.flatMap(snapshot => snapshot.kind === 'resolved' ? [snapshot.profileId] : []) : [], [managedInventoryDemand, snapshots]);
    const { machinesByEnrolledMachineIdByServerId } = useManagedMachineInventory(managedHomes);
    // Carry the incumbent projection into its next input instead of rebuilding unchanged members.
    const retainedProjection = React.useRef<{
        snapshots: readonly ServerMachineInventorySnapshotV1[];
        rows: readonly MachineAdministrationTargetPickerRowV1[];
    } | null>(null);
    const projection = React.useMemo(() => {
        const current = { snapshots, rows: buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots, managedMachinesByServerId: machinesByEnrolledMachineIdByServerId,
            previous: retainedProjection.current ?? undefined,
        }) };
        retainedProjection.current = current;
        return current;
    }, [snapshots, machinesByEnrolledMachineIdByServerId]);
    const targets = React.useMemo(() => livePresence ? snapshots.flatMap(snapshot => snapshot.kind === 'resolved'
        ? [{ serverId: snapshot.profileId, machineIds: snapshot.machines.map(machine => machine.id) }] : []) : NO_PRESENCE_TARGETS,
    [livePresence, snapshots]);
    const readMachines = React.useCallback(() => livePresence ? projection.rows.map(row => row.machine) : [], [livePresence, projection]);
    const readSnapshot = React.useMemo(() => {
        if (!livePresence) return () => projection.rows;
        const scopes = new Map(snapshots.flatMap(snapshot => snapshot.kind === 'resolved'
            ? [[snapshot.profileId, createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId)] as const] : []));
        return (nowMs: number) => {
            const resolveScopeId = captureServerProfileScopeResolver();
            let changed = false;
            const next = projection.rows.map(row => {
                // Presence cannot resurrect a resource the managed owner says is absent.
                if (row.candidate.availability === 'missing') return row;
                const availability = resolveFleetMachineAvailability(scopes.get(row.serverId), row.machine, nowMs, resolveScopeId);
                if (availability === row.candidate.availability) return row;
                changed = true;
                return Object.freeze({ ...row, candidate: Object.freeze({ ...row.candidate, availability }) });
            });
            if (changed) projection.rows = Object.freeze(next);
            return projection.rows;
        };
    }, [livePresence, projection, snapshots]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets);
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
    const expectedSettingsScope = useAccountSettingsScope();
    const writeSetting = useSettingActionWriter();
    const automaticTarget = useMachineAdministrationTargetObservation(expectedSettingsScope, selectionKey);
    const activeAccountScope = useActiveServerAccountScope();
    const requestedInitialTarget = options.initialTarget ?? null;
    const initialTargetKey = options.initialTarget === undefined ? undefined : JSON.stringify(requestedInitialTarget);
    // A route overrides this presentation until the person explicitly changes the target.
    const [initialTargetIntentState, setInitialTargetIntentState] = React.useState({ key: initialTargetKey, applied: false, target: requestedInitialTarget });
    let currentInitialTargetIntent = initialTargetIntentState;
    if (currentInitialTargetIntent.key !== initialTargetKey) {
        currentInitialTargetIntent = { key: initialTargetKey, applied: false, target: requestedInitialTarget };
        setInitialTargetIntentState(currentInitialTargetIntent);
    }
    const initialTargetIntent = React.useRef(currentInitialTargetIntent);
    initialTargetIntent.current = currentInitialTargetIntent;
    const initialTarget = currentInitialTargetIntent.target;
    const releaseInitialTarget = React.useCallback(() => {
        const current = initialTargetIntent.current;
        if (current.key !== initialTargetKey || initialTargetKey === undefined || current.applied) return;
        const released = { ...current, applied: true };
        initialTargetIntent.current = released;
        setInitialTargetIntentState(released);
    }, [initialTargetKey]);
    const initialTargetPending = initialTargetKey !== undefined && !initialTargetIntent.current.applied;
    const storedTarget = initialTargetPending ? initialTarget : readSelectedMachineAdministrationTarget(selections, selectionKey, automaticTarget);
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
    const accountScope = options.accountScope;
    // A selected-row reader reads its stored Machine's row; until one is stored, only every candidate's eligibility to initialize one.
    const selectedRow = options.rows === 'selected' ? storedTarget : null;
    const inventorySelection = React.useMemo(() => selectedRow
        ? { scope: { serverId: selectedRow.serverIdentityId }, machineId: selectedRow.machineId }
        : accountScope ? { scope: accountScope, machineId: null } : undefined,
    [selectedRow?.serverIdentityId, selectedRow?.machineId, accountScope?.serverId, accountScope?.accountId]);
    const inventorySnapshots = useAllProfileMachineInventorySnapshots(enabled, inventorySelection,
        options.rows === 'selected' && !storedTarget ? MACHINE_ADMINISTRATION_AUTOMATIC_CHOICE_DEMAND
            : selectionKey === MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.providers || options.rows === 'selected'
                ? readMachineAdministrationTargetFacts : undefined);
    const snapshots = React.useMemo(() => accountScope ? inventorySnapshots.filter(snapshot => snapshot.kind === 'resolved'
        && snapshot.accountId === accountScope.accountId
        && areServerProfileIdentifiersEquivalent(snapshot.profileId, accountScope.serverId)) : inventorySnapshots,
    [inventorySnapshots, accountScope?.serverId, accountScope?.accountId]);
    const bindings = useServerCredentialAccountScopeBindings(snapshots.flatMap(snapshot => snapshot.kind === 'resolved' ? [snapshot.profileId] : []));
    const resolveScopedTarget = React.useCallback((target: MachineAdministrationTargetV1 | null, options?: MachineAdministrationExecutionTargetOptions) => {
        const binding = [...bindings.values()].find(value => value.isCurrent()
            && target && areServerProfileIdentifiersEquivalent(value.serverId, target.serverIdentityId)
            && (!accountScope || value.scope.accountId === accountScope.accountId
                && areServerProfileIdentifiersEquivalent(value.scope.serverId, accountScope.serverId)));
        return resolveFreshMachineAdministrationExecutionTarget(target, { ...options, accountScope: binding?.scope ?? null });
    }, [bindings, accountScope?.serverId, accountScope?.accountId]);
    // A selected-row reader's snapshot already re-reads its demanded presence; per-row presence is the chooser's.
    const inventoryRows = useMachineAdministrationInventoryRows(snapshots, true, options.rows !== 'selected');
    const pickerRows = React.useMemo(() => buildMachineAdministrationTargetPickerRows(inventoryRows), [inventoryRows]);
    const candidates = React.useMemo(
        () => Object.freeze(inventoryRows.map((row) => row.candidate)),
        [inventoryRows],
    );
    const allowSoleCandidate = enabled && areMachineAdministrationInventoriesKnown(snapshots)
        && options.allowSoleCandidate !== false && !initialTargetPending;
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
        if (readMachineAdministrationTargetPreference(current.settings.machineAdministrationTargetsLocalV1, selectionKey)) return;
        rememberMachineAdministrationTargetObservation(expectedSettingsScope, selectionKey, targetState.target);
    }, [allowSoleCandidate, expectedSettingsScope, selectionKey, storedTarget, targetState]);

    const selectTarget = React.useCallback((target: MachineAdministrationTargetV1) => {
        const candidate = candidates.find((item) => (
            item.target.serverIdentityId === target.serverIdentityId
            && item.target.machineId === target.machineId
        ));
        if (!candidate || !isMachineAdministrationCandidateExplicitlySelectable(candidate, explicitSelection)) return;
        const current = storage.getState();
        if (!expectedSettingsScope || !areAccountSettingsScopesEqual(expectedSettingsScope, current.settingsScope)) return;
        const operation = writeSetting({ anchor: 'machines.administrationTarget', key: selectionKey }, candidate.target)
            .then(result => { if (result.ok) releaseInitialTarget(); });
        fireAndForget(operation, { tag: 'administration.target.select' });
        return operation;
    }, [candidates, expectedSettingsScope, explicitSelection, releaseInitialTarget, selectionKey, writeSetting]);

    const clearTarget = React.useCallback(() => {
        const current = storage.getState();
        if (!expectedSettingsScope || !areAccountSettingsScopesEqual(expectedSettingsScope, current.settingsScope)) return;
        const operation = writeSetting({ anchor: 'machines.administrationTarget', key: selectionKey }, null)
            .then(result => { if (result.ok) releaseInitialTarget(); });
        fireAndForget(operation, { tag: 'administration.target.clear' });
        return operation;
    }, [expectedSettingsScope, releaseInitialTarget, selectionKey, writeSetting]);

    const resolveExecutionTarget = React.useCallback((options?: MachineAdministrationExecutionTargetOptions) => {
        if (!enabled) return null;
        if (initialTargetIntent.current.key !== initialTargetKey) return null;
        const target = initialTargetKey !== undefined && !initialTargetIntent.current.applied
            ? initialTarget : readSelectedMachineAdministrationTarget(storage.getState().settings.machineAdministrationTargetsLocalV1, selectionKey,
                readMachineAdministrationTargetObservation(expectedSettingsScope, selectionKey));
        selectionRevisionRef.current = advanceMachineAdministrationSelectionRevision(
            selectionRevisionRef.current,
            selectionKey,
            target,
        );
        const resolved = resolveScopedTarget(target, options);
        return resolved === null
            ? null
            : Object.freeze({
                ...resolved,
                selectionRevision: selectionRevisionRef.current.revision,
            });
    }, [enabled, expectedSettingsScope, initialTarget, initialTargetKey, selectionKey, resolveScopedTarget]);

    return React.useMemo(() => ({
        candidates,
        pickerRows,
        state: targetState,
        selectedTarget: storedTarget,
        selectedTargetServerMatchesActiveAccount,
        canExecute: enabled && resolveScopedTarget(storedTarget) !== null,
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
        resolveScopedTarget,
    ]);
}
