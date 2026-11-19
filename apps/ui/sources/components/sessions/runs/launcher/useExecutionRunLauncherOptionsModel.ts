import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderBoundModelRefSchema, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { resolveSessionRoutePresentation } from '@/providers/session/resolveSessionRoutePresentation';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { ReviewEngineListItem } from '@happier-dev/protocol/reviews/reviewEngines';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginSourceCustodyV1Schema, pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { resolveEffectiveInputFields as resolveEffectiveActionInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import * as React from 'react';

import type { MergedBackendProjectionEntry, MergedProviderProjectionEntry } from '@/agents/backendCatalog/mergedProjectionTypes';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
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

import { resolveExecutionRunLauncherActionId, resolveExecutionRunTargetFieldPath, type ExecutionRunIntent } from './executionRunLauncherModel';
import { resolveExecutionRunLauncherBackendChoices, resolveInitialExecutionRunBackendTargetKey } from './resolveExecutionRunLauncherBackendChoices';
import { doesExecutionRunProfileMatchSelectedBackends, resolveExecutionRunLauncherProfileChoices } from './resolveExecutionRunLauncherProfileChoices';
import { resolveExecutionRunPermissionAgentId } from './resolveExecutionRunPermissionAgentId';
import { readReviewLauncherReviewers, readReviewLauncherEngineIds, selectReviewLauncherEngines, useReviewLauncherEngineConfiguration } from './reviewLauncherSelection';
import { clearExecutionRunChildSelection } from './executionRunChildChoice';

export function useExecutionRunLauncherOptionsModel(rawParams: Readonly<{
    sessionId: string | null;
    intent: ExecutionRunIntent;
    actionInput: Record<string, unknown>;
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
    /** Picker edits persist; catalog normalization stays read-only on mount. */
    setUserActionInput?: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
    singleTarget?: boolean;
    enabledAgentIds: readonly string[];
    executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
    reviewEngines?: readonly ReviewEngineListItem[];
    acpCatalogSnapshot?: AcpCatalogSnapshotV1;
    initialBackendTarget: PersistedBackendTargetRefV2 | null;
    fallbackAgentId: string | null;
    machineCapabilitiesState: MachineCapabilitiesCacheState;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
    /** The Machine's own Agent inventory, once it has answered. */
    machineAgents?: readonly MachineAgent[] | null;
    /** Applied parent selection for draft presentation only; host admission still resolves omission. */
    inheritedModelSelection?: ProviderBoundModelRef | null;
    inheritedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    inheritedRoutePresentation?: ReturnType<typeof resolveSessionRoutePresentation>;
    inheritedConnectedServicesSelection?: ConnectedServiceBindingsV2 | null;
}>) {
    const configuration = useReviewLauncherEngineConfiguration(rawParams.actionInput, rawParams.setActionInput, rawParams.intent === 'review');
    const userConfiguration = useReviewLauncherEngineConfiguration(rawParams.actionInput, rawParams.setUserActionInput ?? rawParams.setActionInput, rawParams.intent === 'review');
    const params = { ...rawParams, ...configuration, setUserActionInput: userConfiguration.setActionInput };
    const actionId = resolveExecutionRunLauncherActionId(params.intent);
    const catalogReady = params.intent === 'review' || params.acpCatalogSnapshot?.status === 'ready';
    // Only configured Agents depend on this catalog. Built-in and installed
    // Agent choices retain their own machine projection while it refreshes.
    const backendChoices = React.useMemo(() => resolveExecutionRunLauncherBackendChoices({
        enabledAgentIds: params.enabledAgentIds,
        executionRunsBackends: params.executionRunsBackends,
        reviewEngines: params.reviewEngines,
        acpCatalogSnapshot: params.acpCatalogSnapshot,
        intent: params.intent,
        mergedBackendProjectionById: params.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: params.mergedProviderProjectionById ?? null,
        machineAgents: params.machineAgents ?? null,
    }), [
        params.acpCatalogSnapshot,
        params.enabledAgentIds,
        params.executionRunsBackends,
        params.reviewEngines,
        params.intent,
        params.machineAgents,
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
        value: params.intent === 'review' ? choice.reviewEngineId ?? choice.backendId : choice.targetKey,
        label: choice.title,
        ...(choice.disabled ? { disabled: true as const } : {}),
    })), [backendChoices, params.intent]);
    const resolveFieldOptions = React.useCallback<ResolveSessionActionFieldOptions>((field): readonly ActionFieldOption[] => {
        const sourceId = typeof field.optionsSourceId === 'string' ? field.optionsSourceId : '';
        if (sourceId === 'review.engines.available' || sourceId === 'execution.backends.enabled') return backendOptions;
        return field.options ?? [];
    }, [backendOptions]);
    const targetFieldPath = resolveExecutionRunTargetFieldPath(params.intent);
    const targetField = fields.find((field) => field.path === targetFieldPath) ?? null;
    const selectedValues = React.useMemo(() => {
        if (params.intent === 'review') return readReviewLauncherEngineIds(params.actionInput);
        const raw = getValueAtPath(params.actionInput, targetFieldPath);
        return Array.isArray(raw) ? raw.map(String) : [];
    }, [params.actionInput, params.intent, targetFieldPath]);
    const selectedBackendChoices = React.useMemo(() => backendChoices.filter((choice) => (
        selectedValues.includes(choice.targetKey) || selectedValues.includes(choice.backendId)
        || (choice.reviewEngineId !== undefined && selectedValues.includes(choice.reviewEngineId))
    )), [backendChoices, selectedValues]);
    const selectedBackendChoice = (params.intent !== 'review' || selectedValues.length === 1) && selectedBackendChoices.length === 1 && selectedBackendChoices[0]?.disabled !== true
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
    // The Session's own Agent, shown while the Machine has not yet said whether it can run here.
    const initialBackendChoice = React.useMemo(
        () => params.initialBackendTarget
            ? backendChoices.find((choice) => backendTargetKeysMatch(choice.backendTarget, params.initialBackendTarget!)) ?? null
            : null,
        [backendChoices, params.initialBackendTarget],
    );
    // An unanswered Machine leaves every choice unavailable; that must not rewrite the person's
    // selection, which settles against the answer when it arrives.
    const machineAnswered = params.intent === 'review' ? params.reviewEngines !== undefined : params.executionRunsBackends != null;

    React.useEffect(() => {
        if (!catalogReady || !machineAnswered) return;
        if (params.intent === 'review' && readReviewLauncherReviewers(params.actionInput).length > 0) return;
        const valueOf = (choice: typeof backendChoices[number]) => params.intent === 'review' ? choice.reviewEngineId ?? choice.backendId : choice.targetKey;
        const selectable = backendChoices.filter(choice => !choice.disabled);
        const selectableValues = selectable.map(valueOf);
        const preserved = selectedValues
            .filter((value) => selectableValues.includes(value))
            .slice(0, params.singleTarget ? 1 : undefined);
        const initialChoice = initialBackendTargetKey
            ? selectable.find((choice) => choice.targetKey === initialBackendTargetKey)
            : null;
        const preferred = initialChoice
            ? (params.intent === 'review' ? initialChoice.reviewEngineId ?? initialChoice.backendId : initialChoice.targetKey)
            : selectableValues[0];
        const next = preserved.length > 0
            ? preserved
            : targetField?.requireExplicitSelection === true && !params.singleTarget
                ? []
                : preferred ? [preferred] : [];
        if (selectedValues.length === next.length && selectedValues.every((value, index) => value === next[index])) return;
        params.setActionInput(previous => params.intent === 'review' ? selectReviewLauncherEngines(previous, next) : {
            ...previous, ...setValueAtTopLevelPatch(previous, targetFieldPath, next),
        });
    }, [catalogReady, machineAnswered, backendChoices, initialBackendTargetKey, params.intent, params.setActionInput, params.singleTarget, selectedValues, targetField?.requireExplicitSelection, targetFieldPath]);

    React.useEffect(() => {
        if (!catalogReady || !machineAnswered || !requestedProfileId) return;
        if (selectedProfileChoice && !selectedProfileChoice.disabled && selectedProfileMatchesSelectedBackend) return;
        params.setActionInput((previous) => {
            const next = { ...previous };
            delete next.profileId;
            delete next.profileSourceCustody;
            return next;
        });
    }, [catalogReady, machineAnswered, params.setActionInput, requestedProfileId, selectedProfileChoice, selectedProfileMatchesSelectedBackend]);

    // A model belongs to the Agent it was chosen for; choosing another Agent drops it.
    const draftModelSelection = ProviderBoundModelRefSchema.safeParse(params.actionInput.modelSelection);
    const draftModelAgentTargetKey = draftModelSelection.success && draftModelSelection.data ? draftModelSelection.data.agentTargetKey : null;
    React.useEffect(() => {
        if (!draftModelAgentTargetKey) return;
        if (params.intent === 'review' && selectedValues.length !== 1) return;
        if (!selectedBackendChoice || backendTargetKeysMatch(draftModelAgentTargetKey, selectedBackendChoice.backendTarget)) return;
        if (params.intent === 'review') {
            rawParams.setActionInput(clearExecutionRunChildSelection);
            return;
        }
        params.setActionInput(({ modelSelection: _modelSelection, ...rest }) => rest);
    }, [draftModelAgentTargetKey, params.intent, params.setActionInput, selectedBackendChoice, selectedValues.length]);

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
        const value = params.intent === 'review' ? choice.reviewEngineId ?? choice.backendId : choice.targetKey;
        (params.setUserActionInput ?? params.setActionInput)((previous) => {
            const currentRaw = getValueAtPath(previous, targetFieldPath);
            const current = params.intent === 'review' ? readReviewLauncherEngineIds(previous) : Array.isArray(currentRaw) ? currentRaw.map(String) : [];
            const next = params.singleTarget
                ? [value]
                : current.includes(value)
                    ? current.filter((entry) => entry !== value)
                    : typeof targetField?.maxSelections === 'number' && current.length >= targetField.maxSelections
                        ? current
                        : [...current, value];
            return params.intent === 'review' ? selectReviewLauncherEngines(previous, next)
                : { ...previous, ...setValueAtTopLevelPatch(previous, targetFieldPath, next) };
        });
    }, [backendChoices, params.intent, params.setActionInput, params.setUserActionInput, params.singleTarget, targetField?.maxSelections, targetFieldPath]);
    const onSelectProfile = React.useCallback((choice: (typeof profileChoices)[number]) => {
        if (!choice.compatibleAgentId) return;
        const backend = backendChoices.find((candidate) => candidate.backendId === choice.compatibleAgentId);
        if (!backend || backend.disabled) return;
        const value = params.intent === 'review' ? backend.reviewEngineId ?? backend.backendId : backend.targetKey;
        (params.setUserActionInput ?? params.setActionInput)((previous) => ({
            ...previous,
            ...(params.intent === 'review' ? selectReviewLauncherEngines(previous, [value]) : setValueAtTopLevelPatch(previous, targetFieldPath, [value])),
            profileId: choice.id,
            profileSourceCustody: choice.sourceCustody,
        }));
    }, [backendChoices, params.intent, params.setActionInput, params.setUserActionInput, profileChoices, targetFieldPath]);
    const onPatch = React.useCallback((patch: Record<string, unknown>) => {
        const normalized = normalizeActionInputPatch({ actionId, patch });
        (params.setUserActionInput ?? params.setActionInput)((previous) => ({ ...previous, ...normalized }));
    }, [actionId, params.setActionInput, params.setUserActionInput]);

    const targetMatchesParent = selectedBackendChoice !== null && params.initialBackendTarget !== null
        && backendTargetKeysMatch(selectedBackendChoice.targetKey, params.initialBackendTarget);
    const inheritsModel = params.actionInput.modelSelection === undefined
        && params.actionInput.modelId === undefined && params.actionInput.teamCredentialModel === undefined
        && targetMatchesParent;
    const inheritsRoute = inheritsModel && params.actionInput.connectedServices === undefined
        && params.actionInput.connectedServicesByBackendTargetKey === undefined;
    // Review targets are explicitly chosen; an empty default is a missing reviewer, not a
    // permission/scope failure. Send and the control that repairs it consume this one answer.
    const targetRequirement = React.useMemo(() => (params.intent === 'review'
        ? readReviewLauncherReviewers(params.actionInput).length > 0 : selectedBackendChoice !== null)
        ? null : { code: params.intent === 'review' ? 'reviewer_required' : 'agent_required', fieldPath: targetFieldPath },
    [params.intent, params.actionInput, selectedBackendChoice, targetFieldPath]);
    return {
        catalogReady,
        actionId,
        actionSpec,
        fields,
        backendChoices,
        initialBackendChoice,
        selectedBackendChoice,
        targetRequirement,
        targetMatchesParent,
        inheritedDraftSelection: inheritsModel && !params.inheritedTeamCredentialModel ? params.inheritedModelSelection ?? null : null,
        inheritedDraftTeamCredentialModel: inheritsModel ? params.inheritedTeamCredentialModel ?? null : null,
        inheritedDraftRoutePresentation: inheritsRoute ? params.inheritedRoutePresentation ?? null : null,
        inheritedDraftConnectedServicesSelection: inheritsRoute ? params.inheritedConnectedServicesSelection ?? null : null,
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
