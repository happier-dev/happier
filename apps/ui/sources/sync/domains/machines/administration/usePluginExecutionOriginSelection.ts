import * as React from 'react';
import {
    isExactPluginMachineMaterializationRefV1,
    isPluginMachineMaterializationOnServerIdentityV1,
    type PluginMachineExecutionOriginV1,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol';

import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { useSetting } from '@/sync/store/hooks';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    clearPluginMachineExecutionOriginPreference,
    persistMachineAdministrationSelectionMutation,
    setPluginMachineExecutionOriginPreference,
} from './selectionPreferences';
import {
    buildPluginMachineExecutionOriginCandidates,
    composePluginMachineExecutionOriginV1,
    resolvePluginMachineExecutionOriginState,
    type PluginMachineExecutionOriginCandidateV1,
    type PluginMachineExecutionOriginStateV1,
    type PluginMachineReleaseClassificationV1,
} from './pluginExecutionOrigin';
import {
    resolveFreshMachineAdministrationExecutionTarget,
    type FreshMachineAdministrationExecutionTargetV1,
} from './useTargetSelection';

export type FreshPluginMachineExecutionOriginV1 = Readonly<{
    origin: PluginMachineExecutionOriginV1;
    materialization: PluginMachineMaterializationV1;
    machineTarget: FreshMachineAdministrationExecutionTargetV1;
}>;

function materializationMatchesOrigin(
    materialization: PluginMachineMaterializationV1,
    origin: PluginMachineExecutionOriginV1,
): boolean {
    return isPluginMachineMaterializationOnServerIdentityV1(materialization, origin.serverIdentityId)
        && isExactPluginMachineMaterializationRefV1(materialization, origin.materializationRef);
}

/** Invocation-time closure over the current Availability and raw machine owners. */
export function resolveFreshPluginMachineExecutionOrigin(params: Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    reader: PluginAccountAvailabilityReader | null;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
}>): FreshPluginMachineExecutionOriginV1 | null {
    if (!params.origin || !params.reader) return null;
    if (params.origin.materializationRef.pluginId !== params.pluginId) return null;
    const admission = params.reader.readMaterializations();
    if (admission.kind !== 'available') return null;
    const materialization = admission.materializations.find((candidate) => (
        candidate.pluginId === params.pluginId
        && materializationMatchesOrigin(candidate, params.origin!)
    ));
    if (!materialization || !materialization.enabled || materialization.trustState !== 'trusted') return null;
    const release = params.classifyRelease(materialization);
    if (
        release.releaseContent !== 'matched'
        || release.validation.kind !== 'admitted'
        || !materialization.portableRelease
    ) {
        return null;
    }
    const machineTarget = resolveFreshMachineAdministrationExecutionTarget({
        serverIdentityId: materialization.serverIdentityId,
        machineId: materialization.machineId,
    });
    if (!machineTarget) return null;
    return Object.freeze({ origin: params.origin, materialization, machineTarget });
}

export type PluginMachineExecutionOriginSelectionV1 = Readonly<{
    candidates: readonly PluginMachineExecutionOriginCandidateV1[];
    state: PluginMachineExecutionOriginStateV1;
    selectedOrigin: PluginMachineExecutionOriginV1 | null;
    canExecute: boolean;
    selectOrigin: (origin: PluginMachineExecutionOriginV1) => void;
    clearOrigin: () => void;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
}>;

/**
 * Exact plugin-origin selection over the canonical Account Availability
 * reader. Artifact release classification is a required dependency, keeping
 * immutable-content and compatibility authority out of Administration.
 */
export function usePluginMachineExecutionOriginSelection(params: Readonly<{
    pluginId: string;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
}>): PluginMachineExecutionOriginSelectionV1 {
    const reader = useActivePluginAccountAvailabilityReader();
    const machineSnapshots = useAllProfileMachineInventorySnapshots();
    const selections = useSetting('machineAdministrationSelectionsV1');
    const storedOrigin = selections.pluginExecutionOriginsByPluginId[params.pluginId] ?? null;
    const materializationAdmission = React.useMemo(
        () => reader?.readMaterializations() ?? null,
        [reader],
    );
    const candidates = React.useMemo(() => buildPluginMachineExecutionOriginCandidates({
        pluginId: params.pluginId,
        materializations: materializationAdmission?.kind === 'available'
            ? materializationAdmission.materializations
            : [],
        machineSnapshots,
        classifyRelease: params.classifyRelease,
    }), [machineSnapshots, materializationAdmission, params.classifyRelease]);
    const state = React.useMemo(() => resolvePluginMachineExecutionOriginState({
        pluginId: params.pluginId,
        storedOrigin,
        candidates,
    }), [candidates, params.pluginId, storedOrigin]);

    React.useEffect(() => {
        if (storedOrigin || state.kind !== 'selected' || state.selectionSource !== 'soleCandidate') return;
        fireAndForget(persistMachineAdministrationSelectionMutation((current) => (
            setPluginMachineExecutionOriginPreference(current, params.pluginId, state.origin)
        )), { tag: 'usePluginMachineExecutionOriginSelection.initialize' });
    }, [params.pluginId, state, storedOrigin]);

    const selectOrigin = React.useCallback((origin: PluginMachineExecutionOriginV1) => {
        const proposed = resolvePluginMachineExecutionOriginState({
            pluginId: params.pluginId,
            storedOrigin: origin,
            candidates,
        });
        if (proposed.kind !== 'selected') return;
        fireAndForget(persistMachineAdministrationSelectionMutation((current) => (
            setPluginMachineExecutionOriginPreference(current, params.pluginId, proposed.origin)
        )), { tag: 'usePluginMachineExecutionOriginSelection.select' });
    }, [candidates, params.pluginId]);

    const clearOrigin = React.useCallback(() => {
        fireAndForget(persistMachineAdministrationSelectionMutation((current) => (
            clearPluginMachineExecutionOriginPreference(current, params.pluginId)
        )), { tag: 'usePluginMachineExecutionOriginSelection.clear' });
    }, [params.pluginId]);

    const resolveExecutionOrigin = React.useCallback(() => resolveFreshPluginMachineExecutionOrigin({
        pluginId: params.pluginId,
        origin: selections.pluginExecutionOriginsByPluginId[params.pluginId] ?? null,
        reader,
        classifyRelease: params.classifyRelease,
    }), [params.classifyRelease, params.pluginId, reader, selections.pluginExecutionOriginsByPluginId]);

    return React.useMemo(() => ({
        candidates,
        state,
        selectedOrigin: storedOrigin,
        canExecute: resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin: storedOrigin,
            reader,
            classifyRelease: params.classifyRelease,
        }) !== null,
        selectOrigin,
        clearOrigin,
        resolveExecutionOrigin,
    }), [
        candidates,
        clearOrigin,
        params.classifyRelease,
        params.pluginId,
        reader,
        resolveExecutionOrigin,
        selectOrigin,
        state,
        storedOrigin,
    ]);
}
