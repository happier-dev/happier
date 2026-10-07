import type { AcpCatalogSettingsV1, PersistedBackendTargetRefV2 } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginSourceCustodyV1Schema, pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import * as React from 'react';

import type { MergedBackendProjectionEntry, MergedProviderProjectionEntry } from '@/agents/backendCatalog/mergedProjectionTypes';
import type { ActionFieldOption } from '@/components/sessions/actions/ActionInputFields';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { getValueAtPath, setValueAtTopLevelPatch } from '@/components/sessions/actions/ActionInputFields';
import type { MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import { getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { extractExecutionRunProfilesFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import type { ExecutionRunsBackendSnapshotEntry } from '@/sync/domains/reviews/reviewEngineCatalog';
import { normalizeActionInputPatch } from '@/sync/domains/actions/normalizeActionInputPatch';
import { resolveExecutionRunActionAllowedPermissionModes } from '@/sync/domains/actions/resolveExecutionRunActionAllowedPermissionModes';
import { resolveExecutionRunActionDefaultPermissionMode } from '@/sync/domains/actions/resolveExecutionRunActionDefaultPermissionMode';
import { toExecutionRunActionPermissionMode } from '@/sync/domains/actions/executionRunActionPermissionMode';

import { resolveExecutionRunLauncherActionId, type ExecutionRunIntent } from './executionRunLauncherModel';
import { resolveExecutionRunLauncherBackendChoices, resolveInitialExecutionRunBackendTargetKey } from './resolveExecutionRunLauncherBackendChoices';
import { doesExecutionRunProfileMatchSelectedBackends, resolveExecutionRunLauncherProfileChoices } from './resolveExecutionRunLauncherProfileChoices';
import { resolveExecutionRunPermissionAgentId } from './resolveExecutionRunPermissionAgentId';

export function useExecutionRunLauncherOptionsModel(params: Readonly<{
    sessionId: string;
    intent: ExecutionRunIntent;
    actionInput: Record<string, unknown>;
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
    singleTarget?: boolean;
    enabledAgentIds: readonly string[];
    executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
    acpCatalogSettingsV1: AcpCatalogSettingsV1;
    initialBackendTarget: PersistedBackendTargetRefV2 | null;
    fallbackAgentId: string | null;
    machineCapabilitiesState: MachineCapabilitiesCacheState;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>) {
    const actionId = resolveExecutionRunLauncherActionId(params.intent);
    const backendChoices = React.useMemo(() => resolveExecutionRunLauncherBackendChoices({
        enabledAgentIds: params.enabledAgentIds,
        executionRunsBackends: params.executionRunsBackends,
        acpCatalogSettingsV1: params.acpCatalogSettingsV1,
        intent: params.intent,
        mergedBackendProjectionById: params.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: params.mergedProviderProjectionById ?? null,
    }), [
        params.acpCatalogSettingsV1,
        params.enabledAgentIds,
        params.executionRunsBackends,
        params.intent,
        params.mergedBackendProjectionById,
        params.mergedProviderProjectionById,
    ]);
    const profiles = React.useMemo(
        () => extractExecutionRunProfilesFromMachineCapabilitiesState(params.machineCapabilitiesState),
        [params.machineCapabilitiesState],
    );
    const profileChoices = React.useMemo(() => resolveExecutionRunLauncherProfileChoices({
        intent: params.intent,
        profiles,
        backendChoices,
    }), [backendChoices, params.intent, profiles]);
    const actionSpec = React.useMemo(() => getActionSpec(actionId), [actionId]);
    const fields = React.useMemo(
        () => resolveEffectiveActionInputFields(actionSpec, { sessionId: params.sessionId, ...params.actionInput }),
        [actionSpec, params.actionInput, params.sessionId],
    );
    const backendOptions = React.useMemo<readonly ActionFieldOption[]>(() => backendChoices.map((choice) => ({
        value: params.intent === 'review' ? choice.backendId : choice.targetKey,
        label: choice.title,
        ...(choice.disabled ? { disabled: true as const } : {}),
    })), [backendChoices, params.intent]);
    const resolveFieldOptions = React.useCallback<ResolveSessionActionFieldOptions>((field): readonly ActionFieldOption[] => {
        const sourceId = typeof field.optionsSourceId === 'string' ? field.optionsSourceId : '';
        if (sourceId === 'review.engines.available' || sourceId === 'execution.backends.enabled') return backendOptions;
        return field.options ?? [];
    }, [backendOptions]);
    const targetFieldPath = params.intent === 'review' ? 'engineIds' : 'backendTargetKeys';
    const targetField = fields.find((field) => field.path === targetFieldPath) ?? null;
    const selectedValues = React.useMemo(() => {
        const raw = getValueAtPath(params.actionInput, targetFieldPath);
        return Array.isArray(raw) ? raw.map(String) : [];
    }, [params.actionInput, targetFieldPath]);
    const selectedBackendChoices = React.useMemo(() => backendChoices.filter((choice) => (
        selectedValues.includes(choice.targetKey) || selectedValues.includes(choice.backendId)
    )), [backendChoices, selectedValues]);
    const selectedBackendChoice = selectedBackendChoices.length === 1 && selectedBackendChoices[0]?.disabled !== true
        ? selectedBackendChoices[0]!
        : null;
    const requestedProfileId = typeof params.actionInput.profileId === 'string' ? params.actionInput.profileId : '';
    const requestedProfileSourceCustody = PluginSourceCustodyV1Schema.safeParse(params.actionInput.profileSourceCustody);
    const selectedProfileChoice = requestedProfileSourceCustody.success
        ? profileChoices.find((choice) => choice.id === requestedProfileId
            && pluginSourceCustodyV1Equal(choice.sourceCustody, requestedProfileSourceCustody.data)) ?? null
        : null;
    const selectedProfileMatchesSelectedBackend = !selectedProfileChoice || doesExecutionRunProfileMatchSelectedBackends(
        selectedProfileChoice,
        selectedBackendChoices.map((choice) => choice.backendId),
    );
    const initialBackendTargetKey = React.useMemo(
        () => resolveInitialExecutionRunBackendTargetKey(params.initialBackendTarget, backendChoices),
        [backendChoices, params.initialBackendTarget],
    );

    React.useEffect(() => {
        const selectable = backendChoices.filter((choice) => !choice.disabled);
        const selectableValues = selectable.map((choice) => params.intent === 'review' ? choice.backendId : choice.targetKey);
        const preserved = selectedValues
            .filter((value) => selectableValues.includes(value))
            .slice(0, params.singleTarget ? 1 : undefined);
        const initialChoice = initialBackendTargetKey
            ? selectable.find((choice) => choice.targetKey === initialBackendTargetKey)
            : null;
        const preferred = initialChoice
            ? (params.intent === 'review' ? initialChoice.backendId : initialChoice.targetKey)
            : selectableValues[0];
        const next = preserved.length > 0
            ? preserved
            : targetField?.requireExplicitSelection === true && !params.singleTarget
                ? []
                : preferred ? [preferred] : [];
        if (selectedValues.length === next.length && selectedValues.every((value, index) => value === next[index])) return;
        params.setActionInput((previous) => ({
            ...previous,
            ...setValueAtTopLevelPatch(previous, targetFieldPath, next),
        }));
    }, [backendChoices, initialBackendTargetKey, params.intent, params.setActionInput, params.singleTarget, selectedValues, targetField?.requireExplicitSelection, targetFieldPath]);

    React.useEffect(() => {
        if (!requestedProfileId) return;
        if (selectedProfileChoice && !selectedProfileChoice.disabled && selectedProfileMatchesSelectedBackend) return;
        params.setActionInput((previous) => {
            const next = { ...previous };
            delete next.profileId;
            delete next.profileSourceCustody;
            return next;
        });
    }, [params.setActionInput, requestedProfileId, selectedProfileChoice, selectedProfileMatchesSelectedBackend]);

    const permissionModeOptions = React.useMemo(() => {
        const agentId = resolveExecutionRunPermissionAgentId({ selectedBackendChoices, fallbackAgentId: params.fallbackAgentId });
        if (!agentId) return [];
        return getPermissionModeOptionsForAgentType(agentId).map((option) => ({
            ...option,
            value: toExecutionRunActionPermissionMode(option.value),
        }));
    }, [params.fallbackAgentId, selectedBackendChoices]);
    const selectedPermissionMode = typeof params.actionInput.permissionMode === 'string' ? params.actionInput.permissionMode : '';
    const selectedNotifyParentOnCompletion = typeof params.actionInput.notifyParentOnCompletion === 'boolean'
        ? params.actionInput.notifyParentOnCompletion
        : undefined;
    const allowedPermissionModes = React.useMemo(() => resolveExecutionRunActionAllowedPermissionModes(actionId), [actionId]);
    const visiblePermissionModeOptions = React.useMemo(() => !allowedPermissionModes?.length
        ? permissionModeOptions
        : permissionModeOptions.filter((option) => allowedPermissionModes.some((mode) => mode === option.value)),
    [allowedPermissionModes, permissionModeOptions]);

    React.useEffect(() => {
        if (!allowedPermissionModes?.length || allowedPermissionModes.some((mode) => mode === selectedPermissionMode)) return;
        const preferred = resolveExecutionRunActionDefaultPermissionMode(actionId);
        const next = preferred && allowedPermissionModes.includes(preferred) ? preferred : allowedPermissionModes[0];
        if (!next) return;
        params.setActionInput((previous) => ({ ...previous, ...setValueAtTopLevelPatch(previous, 'permissionMode', next) }));
    }, [actionId, allowedPermissionModes, params.setActionInput, selectedPermissionMode]);

    const onSelectBackend = React.useCallback((targetKey: string) => {
        const choice = backendChoices.find((candidate) => candidate.targetKey === targetKey);
        if (!choice || choice.disabled) return;
        const value = params.intent === 'review' ? choice.backendId : choice.targetKey;
        params.setActionInput((previous) => {
            const currentRaw = getValueAtPath(previous, targetFieldPath);
            const current = Array.isArray(currentRaw) ? currentRaw.map(String) : [];
            const next = params.singleTarget
                ? [value]
                : current.includes(value)
                    ? current.filter((entry) => entry !== value)
                    : typeof targetField?.maxSelections === 'number' && current.length >= targetField.maxSelections
                        ? current
                        : [...current, value];
            return { ...previous, ...setValueAtTopLevelPatch(previous, targetFieldPath, next) };
        });
    }, [backendChoices, params.intent, params.setActionInput, params.singleTarget, targetField?.maxSelections, targetFieldPath]);
    const onSelectProfile = React.useCallback((choice: (typeof profileChoices)[number]) => {
        if (!choice.compatibleAgentId) return;
        const backend = backendChoices.find((candidate) => candidate.backendId === choice.compatibleAgentId);
        if (!backend || backend.disabled) return;
        const value = params.intent === 'review' ? backend.backendId : backend.targetKey;
        params.setActionInput((previous) => ({
            ...previous,
            profileId: choice.id,
            profileSourceCustody: choice.sourceCustody,
            ...setValueAtTopLevelPatch(previous, targetFieldPath, [value]),
        }));
    }, [backendChoices, params.intent, params.setActionInput, profileChoices, targetFieldPath]);
    const onPatch = React.useCallback((patch: Record<string, unknown>) => {
        const normalized = normalizeActionInputPatch({ actionId, patch });
        params.setActionInput((previous) => ({ ...previous, ...normalized }));
    }, [actionId, params.setActionInput]);

    return {
        actionId,
        actionSpec,
        fields,
        backendChoices,
        selectedBackendChoice,
        selectedBackendTargetKeys: selectedBackendChoices.map((choice) => choice.targetKey),
        profileChoices,
        selectedProfileId: selectedProfileChoice?.id ?? '',
        selectedProfileChoice,
        selectedProfileMatchesSelectedBackend,
        selectedPermissionMode,
        selectedNotifyParentOnCompletion,
        visiblePermissionModeOptions,
        resolveFieldOptions,
        onSelectBackend,
        onSelectProfile,
        onPatch,
    };
}
