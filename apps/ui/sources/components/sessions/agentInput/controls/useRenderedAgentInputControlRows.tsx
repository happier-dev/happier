import * as React from 'react';

import type { AgentInputChipPickerOption } from '../components/AgentInputChipPickerTypes';
import type { AgentInputExtraActionChip } from '../agentInputContracts';
import type { AgentInputControlId } from './agentInputControlTypes';
import type { SessionModeChipPresentation } from './resolveSessionModeChipPresentation';
import { buildCoreAgentInputControlNodes } from './buildCoreAgentInputControlNodes';
import { resolveRenderedAgentInputControls } from './resolveRenderedAgentInputControls';
import { resolveRenderedExtraActionChipNodes } from './resolveRenderedExtraActionChipNodes';
import type { AgentId } from '@/agents/catalog/catalog';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { ShakeInstance } from '@/components/ui/feedback/Shaker';
import type { View } from 'react-native';

type ChipStyle = (pressed: boolean) => any;

type SessionModeChipControlLike = Readonly<{
    label: string;
    selectedId: string;
}>;

export function useRenderedAgentInputControlRows(params: Readonly<{
    layout: 'scroll' | 'wrap' | 'collapsed';
    chips: ReadonlyArray<AgentInputExtraActionChip> | undefined;
    overlayAnchorRef: React.RefObject<View | null>;
    themeTint: string;
    showChipLabels: boolean;
    showAutoHideChipLabels: boolean;
    chipStyle: ChipStyle;
    chipStyleAutoHide: ChipStyle;
    textStyle: any;
    countTextStyle: any;
    actionButtonStyle: any;
    actionButtonPressedStyle: any;
    showPermissionChip: boolean;
    permissionChipAnchorRef: React.RefObject<View | null>;
    permissionChipLabel: string | null;
    onPermissionPress: () => void;
    hasActionMenuPopoverSections: boolean;
    actionMenuAnchorRef: React.RefObject<View | null>;
    onActionMenuPress: () => void;
    actionBarIsCollapsed: boolean;
    sessionModeChipControl: SessionModeChipControlLike | null;
    shouldRenderSessionModeChip: boolean;
    sessionModeChipAnchorRef: React.RefObject<View | null>;
    sessionModeChipPresentation: SessionModeChipPresentation | null;
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
    hasAgentSelection: boolean;
    agentChipAnchorRef: React.RefObject<View | null>;
    agentLabel: string;
    onAgentPress: () => void;
    onMachinePress?: () => void;
    machineName?: string | null;
    onPathPress?: () => void;
    currentPath?: string | null;
    onResumePress?: () => void;
    blurInput: () => void;
    resumeSessionId?: string | null;
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
}>): Readonly<{
    controlNodes: ReadonlyArray<React.ReactNode>;
    secondaryLeadingControls: ReadonlyArray<React.ReactNode>;
}> {
    return React.useMemo(() => {
        const extraControlNodesById = resolveRenderedExtraActionChipNodes({
            chips: params.chips,
            renderContext: {
                chipStyle: params.chipStyle,
                showLabel: params.showChipLabels,
                iconColor: params.themeTint,
                textStyle: params.textStyle,
                countTextStyle: params.countTextStyle,
                popoverAnchorRef: params.overlayAnchorRef,
            },
            autoHideRenderContext: {
                chipStyle: params.chipStyleAutoHide,
                showLabel: params.showAutoHideChipLabels,
                iconColor: params.themeTint,
                textStyle: params.textStyle,
                countTextStyle: params.countTextStyle,
                popoverAnchorRef: params.overlayAnchorRef,
            },
        });

        const coreControlNodesById = buildCoreAgentInputControlNodes({
            showPermissionChip: params.showPermissionChip,
            permissionChipAnchorRef: params.permissionChipAnchorRef,
            permissionChipLabel: params.permissionChipLabel,
            onPermissionPress: params.onPermissionPress,
            hasActionMenuPopoverSections: params.hasActionMenuPopoverSections,
            actionMenuAnchorRef: params.actionMenuAnchorRef,
            onActionMenuPress: params.onActionMenuPress,
            actionBarIsCollapsed: params.actionBarIsCollapsed,
            sessionModeChipControl: params.sessionModeChipControl,
            shouldRenderSessionModeChip: params.shouldRenderSessionModeChip,
            sessionModeChipAnchorRef: params.sessionModeChipAnchorRef,
            sessionModeChipPresentation: params.sessionModeChipPresentation,
            sessionModeAccessibilityLabel: params.sessionModeChipPresentation?.label ?? params.sessionModeChipControl?.label ?? '',
            onModePress: params.onModePress,
            hasProfile: params.hasProfile,
            profileChipAnchorRef: params.profileChipAnchorRef,
            profileIcon: params.profileIcon,
            profileLabel: params.profileLabel,
            onProfilePress: params.onProfilePress,
            hasEnvVars: params.hasEnvVars,
            envVarsChipAnchorRef: params.envVarsChipAnchorRef,
            envVarsCount: params.envVarsCount,
            onEnvVarsPress: params.onEnvVarsPress,
            hasAgentSelection: params.hasAgentSelection,
            agentChipAnchorRef: params.agentChipAnchorRef,
            agentLabel: params.agentLabel,
            onAgentPress: params.onAgentPress,
            onMachinePress: params.onMachinePress,
            machineName: params.machineName,
            onPathPress: params.onPathPress,
            currentPath: params.currentPath,
            onResumePress: params.onResumePress,
            blurInput: params.blurInput,
            resumeSessionId: params.resumeSessionId,
            resumeIsChecking: params.resumeIsChecking,
            onAbort: params.onAbort,
            showAbortButton: params.showAbortButton,
            isAborting: params.isAborting,
            shakerRef: params.shakerRef,
            onAbortPress: params.onAbortPress,
            sessionId: params.sessionId,
            onFileViewerPress: params.onFileViewerPress,
            sourceControlCompact: params.sourceControlCompact,
            sourceControlWrapperStyle: params.sourceControlWrapperStyle,
            extraControlNodesById: extraControlNodesById.extraControlNodesById,
            tint: params.themeTint,
            showChipLabels: params.showChipLabels,
            chipStyle: params.chipStyle,
            textStyle: params.textStyle,
            countTextStyle: params.countTextStyle,
            actionButtonStyle: params.actionButtonStyle,
            actionButtonPressedStyle: params.actionButtonPressedStyle,
        });

        const renderedControls = resolveRenderedAgentInputControls({
            layout: params.layout,
            coreControlNodesById,
            extraControlNodesById: extraControlNodesById.extraControlNodesById,
            extraChips: extraControlNodesById.extraChips,
        });

        return {
            controlNodes: renderedControls.chips,
            secondaryLeadingControls: renderedControls.secondaryLeadingControls,
        };
    }, [
        params.actionBarIsCollapsed,
        params.actionButtonPressedStyle,
        params.actionButtonStyle,
        params.actionMenuAnchorRef,
        params.agentChipAnchorRef,
        params.agentLabel,
        params.chipStyle,
        params.chipStyleAutoHide,
        params.chips,
        params.countTextStyle,
        params.currentPath,
        params.envVarsChipAnchorRef,
        params.envVarsCount,
        params.hasActionMenuPopoverSections,
        params.hasAgentSelection,
        params.hasEnvVars,
        params.hasProfile,
        params.isAborting,
        params.layout,
        params.machineName,
        params.onAbort,
        params.onAbortPress,
        params.onActionMenuPress,
        params.onAgentPress,
        params.onEnvVarsPress,
        params.onFileViewerPress,
        params.onMachinePress,
        params.onModePress,
        params.onPathPress,
        params.onPermissionPress,
        params.onProfilePress,
        params.onResumePress,
        params.overlayAnchorRef,
        params.permissionChipAnchorRef,
        params.permissionChipLabel,
        params.profileChipAnchorRef,
        params.profileIcon,
        params.profileLabel,
        params.resumeIsChecking,
        params.resumeSessionId,
        params.sessionId,
        params.sessionModeChipAnchorRef,
        params.sessionModeChipControl,
        params.sessionModeChipPresentation,
        params.shakerRef,
        params.shouldRenderSessionModeChip,
        params.showAbortButton,
        params.showAutoHideChipLabels,
        params.showChipLabels,
        params.showPermissionChip,
        params.sourceControlCompact,
        params.sourceControlWrapperStyle,
        params.textStyle,
        params.themeTint,
        params.blurInput,
    ]);
}
