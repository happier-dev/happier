import * as React from 'react';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';

import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { storage } from '@/sync/domains/state/storageStore';
import { useSetting, useSettingsVersion } from '@/sync/store/hooks';
import {
    type OneShotAccountSettingsMutationResult,
} from '@/sync/engine/settings/syncSettings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import {
    clearPluginMachineExecutionOriginPreference,
    persistMachineAdministrationSelectionMutation,
    setPluginMachineExecutionOriginPreference,
} from './selectionPreferences';
import {
    buildPluginMachineExecutionOriginCandidates,
    buildPluginMachineSourceExecutionOriginCandidates,
    resolvePluginMachineExecutionOriginState,
    type PluginMachineExecutionOriginStateV1,
    type PluginMachineReleaseClassificationV1,
    type PluginMachineSourceExecutionOriginCandidateV1,
    type PluginExecutionOriginCandidateV1,
} from './pluginExecutionOrigin';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { buildMachineAdministrationCandidatesFromSnapshots } from './targetState';
import type { MachineAdministrationCandidateV1 } from './targetSelection';
import {
    resolveFreshMachineAdministrationExecutionTarget,
    type FreshMachineAdministrationExecutionTargetV1,
} from './useTargetSelection';

export type FreshPluginMachineExecutionOriginV1 = Readonly<{
    origin: PluginMachineExecutionOriginV1;
    materialization?: PluginMachineMaterializationV1;
    source?: PluginMachineSourceExecutionOriginCandidateV1['source'];
    machineTarget: FreshMachineAdministrationExecutionTargetV1;
    /** UI-local fence for origin selection changes, including A -> B -> A. */
    selectionRevision?: number;
}>;

type PluginExecutionOriginSelectionRevisionState = Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    revision: number;
}>;

export function advancePluginExecutionOriginSelectionRevision(
    previous: PluginExecutionOriginSelectionRevisionState,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1 | null,
): PluginExecutionOriginSelectionRevisionState {
    const unchanged = previous.pluginId === pluginId
        && (
            previous.origin === null
                ? origin === null
                : origin !== null && arePluginMachineExecutionOriginsEqual(previous.origin, origin)
        );
    return unchanged
        ? previous
        : Object.freeze({ pluginId, origin, revision: previous.revision + 1 });
}

/** Invocation-time closure over the current Availability and raw machine owners. */
export function resolveFreshPluginMachineExecutionOrigin(params: Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    reader: PluginAccountAvailabilityReader | null;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
}>): FreshPluginMachineExecutionOriginV1 | null {
    const admission = params.reader?.readMaterializations();
    const candidates: PluginExecutionOriginCandidateV1[] = admission?.kind === 'available'
        ? admission.materializations.filter((entry) => entry.pluginId === params.pluginId).map((materialization) => {
            const release = params.classifyRelease(materialization);
            const rejected = !materialization.enabled ? 'disabled' as const
                : materialization.trustState !== 'trusted' ? 'untrusted' as const
                    : !resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId }) ? 'offline' as const : null;
            return { materialization, ...release, ...(rejected ? { validation: { kind: 'rejected' as const, reason: rejected } } : {}) };
        }) : [];
    for (const candidate of params.sourceCandidates ?? []) {
        const origin = candidate.source.origin;
        const machineTarget = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: origin.serverIdentityId, machineId: origin.sourceRef.machineId });
        candidates.push(machineTarget ? candidate : { ...candidate, validation: { kind: 'rejected', reason: 'offline' } });
    }
    const state = resolvePluginMachineExecutionOriginState({ pluginId: params.pluginId, storedOrigin: params.origin,
        candidates, declaredDefaultOrigins: params.declaredDefaultOrigins });
    if (state.kind !== 'selected') return null;
    const origin = state.origin;
    const machineTarget = resolveFreshMachineAdministrationExecutionTarget({
        serverIdentityId: origin.serverIdentityId,
        machineId: getPluginMachineExecutionOriginRef(origin).machineId,
    });
    if (!machineTarget) return null;
    return Object.freeze({ origin, ...('source' in state.candidate ? { source: state.candidate.source } : { materialization: state.candidate.materialization }), machineTarget });
}

export type PluginMachineExecutionOriginSelectionV1 = Readonly<{
    candidates: readonly PluginExecutionOriginCandidateV1[];
    machineCandidates?: readonly MachineAdministrationCandidateV1[];
    state: PluginMachineExecutionOriginStateV1;
    selectedOrigin: PluginMachineExecutionOriginV1 | null;
    canExecute: boolean;
    selectOrigin: (origin: PluginMachineExecutionOriginV1) => Promise<PluginExecutionOriginSelectionMutationResult>;
    clearOrigin: () => Promise<PluginExecutionOriginSelectionMutationResult>;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
}>;

export type PluginExecutionOriginSelectionMutationResult =
    | OneShotAccountSettingsMutationResult<void>
    | Readonly<{ status: 'unavailable' }>;

/**
 * Exact plugin-origin selection over the canonical Account Availability
 * reader. Artifact release classification is a required dependency, keeping
 * immutable-content and compatibility authority out of Administration.
 */
export function usePluginMachineExecutionOriginSelection(params: Readonly<{
    pluginId: string;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    enabled?: boolean;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readSourceCandidates?: () => readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    readDeclaredDefaultOrigins?: () => readonly PluginMachineExecutionOriginV1[];
}>): PluginMachineExecutionOriginSelectionV1 {
    const reader = useActivePluginAccountAvailabilityReader();
    const enabled = params.enabled !== false;
    const machineSnapshots = useAllProfileMachineInventorySnapshots(enabled);
    const machineCandidates = React.useMemo(() => enabled
        ? buildMachineAdministrationCandidatesFromSnapshots({ snapshots: machineSnapshots })
        : Object.freeze([]), [enabled, machineSnapshots]);
    const selections = useSetting('machineAdministrationSelectionsV1');
    const settingsVersion = useSettingsVersion();
    const expectedSettingsScope = useAccountSettingsScope();
    const storedOrigin = selections.pluginExecutionOriginsByPluginId[params.pluginId] ?? null;
    const selectionRevisionRef = React.useRef<PluginExecutionOriginSelectionRevisionState>({
        pluginId: params.pluginId,
        origin: storedOrigin,
        revision: 0,
    });
    selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
        selectionRevisionRef.current,
        params.pluginId,
        storedOrigin,
    );
    const materializationAdmission = React.useMemo(
        () => enabled ? reader?.readMaterializations() ?? null : null,
        [enabled, reader],
    );
    const candidates = React.useMemo(() => enabled ? Object.freeze([...buildPluginMachineExecutionOriginCandidates({
        pluginId: params.pluginId,
        materializations: materializationAdmission?.kind === 'available'
            ? materializationAdmission.materializations
            : [],
        machineSnapshots,
        classifyRelease: params.classifyRelease,
    }), ...buildPluginMachineSourceExecutionOriginCandidates({ pluginId: params.pluginId,
        sources: params.sourceCandidates ?? [], machineSnapshots })]) : Object.freeze([]), [enabled, machineSnapshots, materializationAdmission, params.classifyRelease, params.pluginId, params.sourceCandidates]);
    const state = React.useMemo<PluginMachineExecutionOriginStateV1>(() => enabled ? resolvePluginMachineExecutionOriginState({
        pluginId: params.pluginId,
        storedOrigin,
        candidates,
        declaredDefaultOrigins: params.declaredDefaultOrigins,
    }) : Object.freeze({ kind: 'selectionRequired', candidates }), [enabled, candidates, params.declaredDefaultOrigins, params.pluginId, storedOrigin]);
    const currentParamsRef = React.useRef(params);
    currentParamsRef.current = params;

    const selectOrigin = React.useCallback(async (
        origin: PluginMachineExecutionOriginV1,
    ): Promise<PluginExecutionOriginSelectionMutationResult> => {
        if (!enabled) return { status: 'unavailable' };
        const proposed = resolvePluginMachineExecutionOriginState({
            pluginId: params.pluginId,
            storedOrigin: origin,
            candidates,
        });
        if (proposed.kind !== 'selected' || settingsVersion === null) return { status: 'unavailable' };
        return await persistMachineAdministrationSelectionMutation(expectedSettingsScope, settingsVersion, (current) => (
            setPluginMachineExecutionOriginPreference(current, params.pluginId, proposed.origin)
        ));
    }, [enabled, candidates, expectedSettingsScope, params.pluginId, settingsVersion]);

    const clearOrigin = React.useCallback(async (): Promise<PluginExecutionOriginSelectionMutationResult> => {
        if (!enabled || settingsVersion === null) return { status: 'unavailable' };
        return await persistMachineAdministrationSelectionMutation(expectedSettingsScope, settingsVersion, (current) => (
            clearPluginMachineExecutionOriginPreference(current, params.pluginId)
        ));
    }, [enabled, expectedSettingsScope, params.pluginId, settingsVersion]);

    const resolveExecutionOrigin = React.useCallback(() => {
        if (!enabled || !areAccountSettingsScopesEqual(expectedSettingsScope, storage.getState().settingsScope)) return null;
        const origin = storage.getState().settings.machineAdministrationSelectionsV1
            .pluginExecutionOriginsByPluginId[params.pluginId] ?? null;
        selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
            selectionRevisionRef.current,
            params.pluginId,
            origin,
        );
        const resolved = resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin,
            reader,
            classifyRelease: params.classifyRelease,
            sourceCandidates: currentParamsRef.current.readSourceCandidates?.() ?? currentParamsRef.current.sourceCandidates,
            declaredDefaultOrigins: currentParamsRef.current.readDeclaredDefaultOrigins?.() ?? currentParamsRef.current.declaredDefaultOrigins,
        });
        return resolved === null
            ? null
            : Object.freeze({
                ...resolved,
                selectionRevision: selectionRevisionRef.current.revision,
            });
    }, [enabled, expectedSettingsScope, params.classifyRelease, params.pluginId, reader]);

    return React.useMemo(() => ({
        candidates,
        machineCandidates,
        state,
        selectedOrigin: enabled ? state.kind === 'selected' ? state.origin : storedOrigin : null,
        canExecute: enabled && resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin: storedOrigin,
            reader,
            classifyRelease: params.classifyRelease,
            sourceCandidates: params.sourceCandidates,
            declaredDefaultOrigins: params.declaredDefaultOrigins,
        }) !== null,
        selectOrigin,
        clearOrigin,
        resolveExecutionOrigin,
    }), [
        candidates,
        machineCandidates,
        enabled,
        clearOrigin,
        params.classifyRelease,
        params.pluginId,
        params.sourceCandidates,
        params.declaredDefaultOrigins,
        reader,
        resolveExecutionOrigin,
        selectOrigin,
        state,
        storedOrigin,
    ]);
}
