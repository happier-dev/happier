import * as React from 'react';
import { resolveEffectiveApiTokenModelRefV1, resolveEffectiveApiTokenPermissionModeV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createPersonalSessionModelSelection, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';

import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import type { NewSessionCreationProfile } from '@/components/sessions/new/navigation/newSessionHost';
import { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import { isTeamCredentialProviderModelPickerValue, sessionModelPickerValueFromRef } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { narrowSessionModelPickerToAllowedModels, toModelVisibilityKey } from '@/components/sessions/shell/embedded/embeddedSessionPresentation';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';

/** The same effective choices at presentation and launch, without editing the remembered draft. */
export function resolveNewSessionCreationProfileAuthoringInput(
    input: Readonly<{ modelMode: ModelMode; permissionMode: PermissionMode; modelSelection: SessionModelSelection | null }>,
    profile: NewSessionCreationProfile | undefined,
): typeof input {
    if (!profile) return input;
    const effectiveModel = profile.allowedModels
        ? resolveEffectiveApiTokenModelRefV1({ models: [...profile.allowedModels] }, input.modelSelection?.ref, profile.agentTargetKey)
        : input.modelSelection?.ref;
    const modelSelection = effectiveModel && effectiveModel !== 'automatic' && !('source' in effectiveModel)
        && effectiveModel !== input.modelSelection?.ref
        ? createPersonalSessionModelSelection(effectiveModel, 0) : input.modelSelection;
    const permissionMode = profile.permissionModes
        ? resolveEffectiveApiTokenPermissionModeV1({ permissionModes: [...profile.permissionModes] }, input.permissionMode) ?? input.permissionMode
        : input.permissionMode;
    return { modelSelection, modelMode: modelSelection?.ref.modelId ?? input.modelMode, permissionMode };
}

/**
 * The New Session composer as a host's creation profile allows it (the embed's new chat, plan 05
 * §4.3.5). It hides the pickers the host decides and narrows the ones it offers; it never adds an
 * option, and the host's grant enforces what the composer merely stops offering.
 */
export function useNewSessionPanelPropsForCreationProfile(
    props: NewSessionSimplePanelProps,
    profile: NewSessionCreationProfile | undefined,
): NewSessionSimplePanelProps {
    const picker = props.modelPickerProps;
    const agentTargetKey = profile?.agentTargetKey ?? picker?.agentTargetKey;
    const selected = picker?.selected ?? null;
    const effective = resolveNewSessionCreationProfileAuthoringInput({
        modelMode: props.modelMode ?? 'default',
        permissionMode: props.permissionMode ?? 'default',
        modelSelection: selected && !isTeamCredentialProviderModelPickerValue(selected)
            ? createPersonalSessionModelSelection(selected, 0) : null,
    }, profile ? { ...profile, agentTargetKey } : undefined);
    const effectiveSelection = sessionModelPickerValueFromRef(effective.modelSelection?.ref) ?? selected;
    const narrowedPicker = React.useMemo(() => {
        if (!profile || !picker) return null;
        const narrowed = narrowSessionModelPickerToAllowedModels({
            allowedModels: profile.allowedModels,
            agentTargetKey: picker.agentTargetKey,
            nativeModels: picker.nativeModels,
            providerGroups: picker.providerGroups,
            hiddenNativeModelKeys: picker.hiddenNativeModelKeys ?? new Set(),
        });
        const providerGroups = narrowed?.providerGroups ?? picker.providerGroups;
        const providerRow = effectiveSelection && 'providerConnectionId' in effectiveSelection && effectiveSelection.providerConnectionId
            ? providerGroups.flatMap((group) => group.rows).find((row) => (
                'providerConnectionId' in row.ref && toModelVisibilityKey(row.ref) === toModelVisibilityKey(effectiveSelection)
            )) : null;
        // The fixed agent's chip names the model the profile resolves to.
        const modelLabel = providerRow?.descriptor.name
            ?? picker.nativeModels.find((model) => model.value === effectiveSelection?.modelId)?.label
            ?? effectiveSelection?.modelId ?? effective.modelMode;
        return {
            props: { ...picker, ...narrowed, selected: effectiveSelection },
            modelLabel,
        };
    }, [effective.modelMode, effectiveSelection, picker, profile]);
    const modelPickerProps = narrowedPicker?.props ?? picker;
    const modelContentOverride = React.useMemo(() => modelPickerProps && profile
        ? React.createElement(SessionModelPicker, modelPickerProps)
        : props.modelContentOverride, [modelPickerProps, profile, props.modelContentOverride]);
    const permissionModes = profile?.permissionModes ?? null;

    return React.useMemo(() => {
        if (!profile) return props;
        const fixedAgent = profile.agentTargetKey !== undefined;
        return {
            ...props,
            // The host binds the machine: nothing here chooses where, or with which profile.
            machinePopover: undefined,
            profilePopover: undefined,
            useProfiles: false,
            showResumePicker: false,
            resumePopover: undefined,
            ...(fixedAgent ? {
                agentPickerOptions: undefined,
                handleAgentClick: undefined,
                onAgentPickerSelect: undefined,
            } : {}),
            modelPickerProps,
            modelContentOverride,
            modelMode: effective.modelMode,
            permissionMode: effective.permissionMode,
            ...(fixedAgent && narrowedPicker ? { agentLabel: narrowedPicker.modelLabel } : {}),
            allowedPermissionModes: permissionModes,
            // One allowed mode is a fact, not a choice.
            ...(permissionModes && permissionModes.length < 2 ? { handlePermissionModeChange: undefined } : {}),
        };
    }, [effective.modelMode, effective.permissionMode, modelContentOverride, modelPickerProps, narrowedPicker, permissionModes, profile, props]);
}
