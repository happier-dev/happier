import * as React from 'react';
import type {
    MachineAdministrationTargetV1,
} from '@happier-dev/protocol';

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
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
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
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { clearMachineAdministrationTargetObservation, readMachineAdministrationTargetObservation,
    rememberMachineAdministrationTargetObservation, useMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';

import {
    clearMachineAdministrationTargetPreference,
    setMachineAdministrationTargetPreference,
} from './selectionPreferences';
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
    type MachineAdministrationCandidateInventoryRowV1,
} from './targetState';

import { resolveFreshMachineAdministrationExecutionTarget } from './executionTarget';
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
}>;

/** Presentation-only canonical Administration rows, without creating a persisted selection. */
export function useMachineAdministrationTargetPickerRows(): readonly MachineAdministrationTargetPickerRowV1[] {
    const snapshots = useAllProfileMachineInventorySnapshots();
    return useMachineAdministrationInventoryRows(snapshots);
}

/** Inventory owns content; the shared presence owner advances only changed availability facts. */
function useMachineAdministrationInventoryRows(snapshots: readonly ServerMachineInventorySnapshotV1[]): readonly MachineAdministrationTargetPickerRowV1[] {
    const rows = React.useMemo(
        () => buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots }),
        [snapshots],
    );
    const targets = React.useMemo(() => snapshots.flatMap(snapshot => snapshot.kind === 'resolved'
        ? [{ serverId: snapshot.profileId, machineIds: snapshot.machines.map(machine => machine.id) }] : []), [snapshots]);
    const readMachines = React.useCallback(() => rows.map(row => row.machine), [rows]);
    const readSnapshot = React.useMemo(() => {
        const scopes = new Map(snapshots.flatMap(snapshot => snapshot.kind === 'resolved'
            ? [[snapshot.profileId, createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId)] as const] : []));
        let current = rows;
        return (nowMs: number) => {
            const resolveScopeId = captureServerProfileScopeResolver();
            let changed = false;
            const next = current.map(row => {
                const availability = resolveFleetMachineAvailability(scopes.get(row.serverId), row.machine, nowMs, resolveScopeId);
                if (availability === row.candidate.availability) return row;
                changed = true;
                return Object.freeze({ ...row, candidate: Object.freeze({ ...row.candidate, availability }) });
            });
            if (changed) current = Object.freeze(next);
            return current;
        };
    }, [rows, snapshots]);
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
    const automaticTarget = useMachineAdministrationTargetObservation(expectedSettingsScope, selectionKey);
    const activeAccountScope = useActiveServerAccountScope();
    const initialTarget = options.initialTarget ?? null;
    const initialTargetKey = options.initialTarget === undefined ? undefined : JSON.stringify(initialTarget);
    // Consuming a route changes the rendered target even when its preference write is a no-op.
    const [initialTargetIntentState, setInitialTargetIntentState] = React.useState({ key: initialTargetKey, applied: false });
    let currentInitialTargetIntent = initialTargetIntentState;
    if (currentInitialTargetIntent.key !== initialTargetKey) {
        currentInitialTargetIntent = { key: initialTargetKey, applied: false };
        setInitialTargetIntentState(currentInitialTargetIntent);
    }
    const initialTargetIntent = React.useRef(currentInitialTargetIntent);
    initialTargetIntent.current = currentInitialTargetIntent;
    const releaseInitialTarget = React.useCallback(() => {
        const current = initialTargetIntent.current;
        if (current.key !== initialTargetKey || initialTargetKey === undefined || current.applied) return;
        const released = { ...current, applied: true };
        initialTargetIntent.current = released;
        setInitialTargetIntentState(released);
    }, [initialTargetKey]);
    const initialTargetPending = initialTargetKey !== undefined && !initialTargetIntent.current.applied;
    const storedTarget = initialTargetPending ? initialTarget : selections[selectionKey] ?? automaticTarget;
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
    const bindings = useServerCredentialAccountScopeBindings(snapshots.flatMap(snapshot => snapshot.kind === 'resolved' ? [snapshot.profileId] : []));
    const resolveScopedTarget = React.useCallback((target: MachineAdministrationTargetV1 | null, options?: MachineAdministrationExecutionTargetOptions) => {
        const binding = [...bindings.values()].find(value => value.isCurrent()
            && target && areServerProfileIdentifiersEquivalent(value.serverId, target.serverIdentityId));
        return resolveFreshMachineAdministrationExecutionTarget(target, { ...options, accountScope: binding?.scope ?? null });
    }, [bindings]);
    const pickerRows = useMachineAdministrationInventoryRows(snapshots);
    const candidates = React.useMemo(
        () => Object.freeze(pickerRows.map((row) => row.candidate)),
        [pickerRows],
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
        if (current.settings.machineAdministrationTargetsLocalV1[selectionKey]) return;
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
        releaseInitialTarget();
        getSyncSingleton().applySettings({ machineAdministrationTargetsLocalV1: setMachineAdministrationTargetPreference(
            current.settings.machineAdministrationTargetsLocalV1, selectionKey, candidate.target,
        ) }, { expectedSettingsScope, source: 'ui' });
    }, [candidates, expectedSettingsScope, explicitSelection, releaseInitialTarget, selectionKey]);

    const clearTarget = React.useCallback(() => {
        const current = storage.getState();
        if (!expectedSettingsScope || !areAccountSettingsScopesEqual(expectedSettingsScope, current.settingsScope)) return;
        releaseInitialTarget();
        clearMachineAdministrationTargetObservation(expectedSettingsScope, selectionKey);
        getSyncSingleton().applySettings({ machineAdministrationTargetsLocalV1: clearMachineAdministrationTargetPreference(
            current.settings.machineAdministrationTargetsLocalV1, selectionKey,
        ) }, { expectedSettingsScope, source: 'ui' });
    }, [expectedSettingsScope, releaseInitialTarget, selectionKey]);

    const resolveExecutionTarget = React.useCallback((options?: MachineAdministrationExecutionTargetOptions) => {
        if (!enabled) return null;
        if (initialTargetIntent.current.key !== initialTargetKey) return null;
        const target = initialTargetKey !== undefined && !initialTargetIntent.current.applied
            ? initialTarget : storage.getState().settings.machineAdministrationTargetsLocalV1[selectionKey]
                ?? readMachineAdministrationTargetObservation(expectedSettingsScope, selectionKey);
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
