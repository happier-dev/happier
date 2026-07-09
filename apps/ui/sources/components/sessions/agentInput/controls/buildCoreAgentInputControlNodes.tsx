import * as React from 'react';
import type { View } from 'react-native';

import type { AgentId } from '@/agents/catalog/catalog';
import type { AgentInputControlId } from './agentInputControlTypes';
import type { SessionModeChipPresentation } from './resolveSessionModeChipPresentation';
import { createAgentSelectionActionChip } from '../definitions/createAgentSelectionActionChip';
import { createAbortActionButton } from '../definitions/createAbortActionButton';
import { createEnvVarsActionChip } from '../definitions/createEnvVarsActionChip';
import { createMachineActionChip } from '../definitions/createMachineActionChip';
import { createActionMenuTriggerChip } from '../definitions/createActionMenuTriggerChip';
import { createPathActionChip } from '../definitions/createPathActionChip';
import { createPermissionActionChip } from '../definitions/createPermissionActionChip';
import { createProfileActionChip } from '../definitions/createProfileActionChip';
import { createResumeActionChip } from '../definitions/createResumeActionChip';
import { createSessionModeActionChip } from '../definitions/createSessionModeActionChip';
import { createSourceControlActionChip } from '../definitions/createSourceControlActionChip';
import type { ShakeInstance } from '@/components/ui/feedback/Shaker';

type ChipStyle = (pressed: boolean) => any;

type SessionModeChipControlLike = Readonly<{
    label: string;
    selectedId: string;
}>;

export function buildCoreAgentInputControlNodes(params: Readonly<{
    showPermissionChip: boolean;
    permissionChipAnchorRef: React.RefObject<View | null>;
    permissionChipLabel: string | null;
    onPermissionPress: () => void;
    hasActionMenuPopoverSections: boolean;
    actionMenuAnchorRef: React.RefObject<View | null>;
    onActionMenuPress: () => void;
    actionBarIsCollapsed: boolean;
    sessionModeChipControl: SessionModeChipControlLike | null | undefined;
    shouldRenderSessionModeChip: boolean;
    sessionModeChipAnchorRef: React.RefObject<View | null>;
    sessionModeChipPresentation: SessionModeChipPresentation | null | undefined;
    sessionModeAccessibilityLabel: string;
    onModePress: () => void;
    hasProfile: boolean;
    profileChipAnchorRef: React.RefObject<View | null>;
    profileIcon: string;
    profileLabel: string | null;
    onProfilePress: () => void;
    hasEnvVars: boolean;
    envVarsChipAnchorRef: React.RefObject<View | null>;
    envVarsCount?: number;
    onEnvVarsPress: () => void;
    agentId: AgentId;
    hasAgentSelection: boolean;
    agentChipAnchorRef: React.RefObject<View | null>;
    agentLabel: string;
    engineLabel: string;
    onAgentPress: () => void;
    machineChipAnchorRef: React.RefObject<View | null>;
    onMachinePress?: () => void;
    machineName?: string | null;
    pathChipAnchorRef: React.RefObject<View | null>;
    onPathPress?: () => void;
    currentPath?: string | null;
    resumeChipAnchorRef: React.RefObject<View | null>;
    onResumePress?: () => void;
    blurInput: () => void;
    resumeSessionId: string | null | undefined;
    resumeIsChecking?: boolean;
    onAbort?: () => void;
    showAbortButton?: boolean;
    isAborting: boolean;
    shakerRef: React.RefObject<ShakeInstance | null>;
    onAbortPress: () => void;
    sessionId?: string;
    onFileViewerPress?: () => void;
    sourceControlCompact: boolean;
    sourceControlWrapperStyle: any;
    extraControlNodesById: Partial<Record<AgentInputControlId, ReadonlyArray<React.ReactNode>>>;
    tint: string;
    showChipLabels: boolean;
    chipStyle: ChipStyle;
    textStyle: any;
    countTextStyle: any;
    actionButtonStyle: any;
    actionButtonPressedStyle: any;
}>): Partial<Record<AgentInputControlId, ReadonlyArray<React.ReactNode>>> {
    const permissionChip = params.showPermissionChip ? createPermissionActionChip({
        anchorRef: params.permissionChipAnchorRef,
        tint: params.tint,
        showLabel: params.showChipLabels,
        label: params.permissionChipLabel,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
        onPress: params.onPermissionPress,
    }) : null;

    const actionMenuChip = params.hasActionMenuPopoverSections ? createActionMenuTriggerChip({
        anchorRef: params.actionMenuAnchorRef,
        tint: params.tint,
        showLabel: params.showChipLabels,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
        onPress: params.onActionMenuPress,
    }) : null;

    const modeChip = (!params.actionBarIsCollapsed && params.sessionModeChipControl && params.shouldRenderSessionModeChip) ? createSessionModeActionChip({
        anchorRef: params.sessionModeChipAnchorRef,
        tint: params.tint,
        showLabel: params.showChipLabels,
        label: params.sessionModeChipPresentation?.label ?? params.sessionModeChipControl.label,
        labelTestID: `agent-input-session-mode-chip-label:${params.sessionModeChipControl.selectedId}`,
        accessibilityLabel: params.sessionModeAccessibilityLabel,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
        iconKind: params.sessionModeChipPresentation?.iconKind,
        iconName: params.sessionModeChipPresentation?.iconName,
        onPress: params.onModePress,
    }) : null;

    const profileChip = params.hasProfile ? createProfileActionChip({
        anchorRef: params.profileChipAnchorRef,
        profileIcon: params.profileIcon,
        profileLabel: params.profileLabel,
        tint: params.tint,
        showLabel: params.showChipLabels,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
        onPress: params.onProfilePress,
    }) : null;

    const envVarsChip = params.hasEnvVars ? createEnvVarsActionChip({
        anchorRef: params.envVarsChipAnchorRef,
        tint: params.tint,
        showLabel: params.showChipLabels,
        count: params.envVarsCount,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
        countTextStyle: params.countTextStyle,
        onPress: params.onEnvVarsPress,
    }) : null;

    const agentChip = params.hasAgentSelection ? createAgentSelectionActionChip({
        anchorRef: params.agentChipAnchorRef,
        agentId: params.agentId,
        tint: params.tint,
        showLabel: params.showChipLabels,
        label: params.engineLabel,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
        onPress: params.onAgentPress,
    }) : null;

    const machineChip = params.onMachinePress ? createMachineActionChip({
        anchorRef: params.machineChipAnchorRef,
        machineName: params.machineName,
        tint: params.tint,
        showLabel: params.showChipLabels,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
        onPress: params.onMachinePress,
    }) : null;

    const pathChip = params.onPathPress ? createPathActionChip({
        anchorRef: params.pathChipAnchorRef,
        currentPath: params.currentPath,
        tint: params.tint,
        showLabel: params.showChipLabels,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
        onPress: params.onPathPress,
    }) : null;

    const resumeChip = createResumeActionChip({
        anchorRef: params.resumeChipAnchorRef,
        onPress: params.onResumePress,
        blurInput: params.blurInput,
        showLabel: params.showChipLabels,
        agentLabel: params.agentLabel,
        resumeSessionId: params.resumeSessionId,
        resumeIsChecking: params.resumeIsChecking,
        tint: params.tint,
        chipStyle: params.chipStyle,
        textStyle: params.textStyle,
    });

    const abortButton = params.onAbort && params.showAbortButton && !params.actionBarIsCollapsed ? createAbortActionButton({
        shakerRef: params.shakerRef,
        isAborting: params.isAborting,
        tint: params.tint,
        buttonStyle: params.actionButtonStyle,
        buttonPressedStyle: params.actionButtonPressedStyle,
        onPress: params.onAbortPress,
    }) : null;

    const sourceControlChip = !params.actionBarIsCollapsed ? createSourceControlActionChip({
        sessionId: params.sessionId,
        onPress: params.onFileViewerPress,
        compact: params.sourceControlCompact,
        wrapperStyle: params.sourceControlWrapperStyle,
    }) : null;

    return {
        permission: permissionChip ? [permissionChip] : [],
        actionMenu: actionMenuChip ? [actionMenuChip] : [],
        engine: agentChip ? [agentChip] : [],
        mode: modeChip ? [modeChip] : [],
        profile: profileChip ? [profileChip] : [],
        env: envVarsChip ? [envVarsChip] : [],
        stop: abortButton ? [abortButton] : [],
        files: sourceControlChip ? [sourceControlChip] : [],
        ...params.extraControlNodesById,
        machine: machineChip ? [machineChip] : [],
        path: pathChip ? [pathChip] : [],
        resume: resumeChip ? [resumeChip] : [],
    };
}
