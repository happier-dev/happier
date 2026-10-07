import * as React from 'react';
import { resolveEffectiveApiTokenModelRefV1, resolveEffectiveApiTokenPermissionModeV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';

import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import type { NewSessionCreationProfile } from '@/components/sessions/new/navigation/newSessionHost';
import { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import { narrowSessionModelPickerToAllowedModels, toModelVisibilityKey } from '@/components/sessions/shell/embedded/embeddedSessionPresentation';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';

/** The same effective choices at presentation and launch, without editing the remembered draft. */
export function resolveNewSessionCreationProfileAuthoringInput(
    input: Readonly<{ modelMode: ModelMode; permissionMode: PermissionMode; modelSelection: SessionModelSelectionV1 | null }>,
    profile: NewSessionCreationProfile | undefined,
): typeof input {
    if (!profile) return input;
    const effectiveModel = profile.allowedModels
        ? resolveEffectiveApiTokenModelRefV1({ models: [...profile.allowedModels] }, input.modelSelection?.ref, profile.agentTargetKey)
        : input.modelSelection?.ref;
    const modelSelection = effectiveModel && effectiveModel !== 'automatic'
        ? effectiveModel === input.modelSelection?.ref ? input.modelSelection : { v: 1 as const, updatedAt: 0, ref: effectiveModel }
        : input.modelSelection;
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
        modelSelection: selected ? { v: 1, updatedAt: 0, ref: selected } : null,
    }, profile ? { ...profile, agentTargetKey } : undefined);
    const effectiveSelection = effective.modelSelection?.ref ?? null;
    const modelPickerProps = React.useMemo(() => {
        if (!profile || !picker) return picker;
        const narrowed = narrowSessionModelPickerToAllowedModels({
            allowedModels: profile.allowedModels,
            agentTargetKey: picker.agentTargetKey,
            nativeModels: picker.nativeModels,
            providerGroups: picker.providerGroups,
            hiddenNativeModelKeys: picker.hiddenNativeModelKeys ?? new Set(),
        });
        const providerGroups = narrowed?.providerGroups ?? picker.providerGroups;
        const providerRow = effectiveSelection?.providerConnectionId
            ? providerGroups.flatMap((group) => group.rows).find((row) => (
                toModelVisibilityKey(row.ref) === toModelVisibilityKey(effectiveSelection)
            )) : null;
        const effectiveLabel = providerRow?.descriptor.name
            ?? picker.nativeModels.find((model) => model.value === effectiveSelection?.modelId)?.label
            ?? effectiveSelection?.modelId ?? picker.effectiveLabel;
        return {
            ...picker,
            ...narrowed,
            selected: effectiveSelection,
            effectiveLabel,
        };
    }, [effectiveSelection, picker, profile]);
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
            ...(fixedAgent && modelPickerProps ? { agentLabel: modelPickerProps.effectiveLabel } : {}),
            allowedPermissionModes: permissionModes,
            // One allowed mode is a fact, not a choice.
            ...(permissionModes && permissionModes.length < 2 ? { handlePermissionModeChange: undefined } : {}),
        };
    }, [effective.modelMode, effective.permissionMode, modelContentOverride, modelPickerProps, permissionModes, profile, props]);
}
