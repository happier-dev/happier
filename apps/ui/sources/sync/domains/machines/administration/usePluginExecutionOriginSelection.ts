import * as React from 'react';
import {
    arePluginMachineMaterializationRefsEqual,
    arePluginMachineExecutionOriginsEqual,
    isPluginMachineMaterializationOnServerIdentityV1,
    type PluginMachineExecutionOriginV1,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol';

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

function materializationMatchesOrigin(
    materialization: PluginMachineMaterializationV1,
    origin: PluginMachineExecutionOriginV1,
): boolean {
    return isPluginMachineMaterializationOnServerIdentityV1(materialization, origin.serverIdentityId)
        && arePluginMachineMaterializationRefsEqual(materialization, origin.materializationRef);
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
    /** The plugin ships inside Happier (see `resolvePluginMachineExecutionOriginState`). */
    includedWithHappier?: boolean;
}>): PluginMachineExecutionOriginSelectionV1 {
    const reader = useActivePluginAccountAvailabilityReader();
    const machineSnapshots = useAllProfileMachineInventorySnapshots();
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
    }), [machineSnapshots, materializationAdmission, params.classifyRelease, params.pluginId]);
    const includedWithHappier = params.includedWithHappier === true;
    const state = React.useMemo(() => resolvePluginMachineExecutionOriginState({
        pluginId: params.pluginId,
        storedOrigin,
        candidates,
        includedWithHappier,
    }), [candidates, includedWithHappier, params.pluginId, storedOrigin]);

    const selectOrigin = React.useCallback(async (
        origin: PluginMachineExecutionOriginV1,
    ): Promise<PluginExecutionOriginSelectionMutationResult> => {
        const proposed = resolvePluginMachineExecutionOriginState({
            pluginId: params.pluginId,
            storedOrigin: origin,
            candidates,
        });
        if (proposed.kind !== 'selected' || settingsVersion === null) return { status: 'unavailable' };
        return await persistMachineAdministrationSelectionMutation(expectedSettingsScope, settingsVersion, (current) => (
            setPluginMachineExecutionOriginPreference(current, params.pluginId, proposed.origin)
        ));
    }, [candidates, expectedSettingsScope, params.pluginId, settingsVersion]);

    const clearOrigin = React.useCallback(async (): Promise<PluginExecutionOriginSelectionMutationResult> => {
        if (settingsVersion === null) return { status: 'unavailable' };
        return await persistMachineAdministrationSelectionMutation(expectedSettingsScope, settingsVersion, (current) => (
            clearPluginMachineExecutionOriginPreference(current, params.pluginId)
        ));
    }, [expectedSettingsScope, params.pluginId, settingsVersion]);

    const resolveExecutionOrigin = React.useCallback(() => {
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
        });
        return resolved === null
            ? null
            : Object.freeze({
                ...resolved,
                selectionRevision: selectionRevisionRef.current.revision,
            });
    }, [params.classifyRelease, params.pluginId, reader]);

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
