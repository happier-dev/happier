import type { AgentInputFolderChipState } from '../definitions/AgentInputFolderChip';
import * as React from 'react';

import { buildAgentInputActionMenuActions, type AgentInputActionMenuAction } from '../actionMenuActions';
import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { buildCollapsedExtraControlActions } from './buildCollapsedExtraControlActions';
import type { IconName } from '@/components/ui/icons/Icon';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import type { AgentInputResolvedControlLines } from './agentInputControlTypes';

export function useAgentInputActionMenuActions(params: Readonly<{
    resolvedControls: AgentInputResolvedControlLines;
    tint: string;
    agentId: string;
    agentIdentityIcon?: React.ReactNode;
    profileLabel: string | null;
    profileIcon: IconName;
    envVarsCount?: number;
    agentLabel?: string | null;
    engineLabel?: string | null;
    machineName?: string | null;
    currentPath?: string | null;
    folderChipState?: AgentInputFolderChipState;
    onRemoveFolder?: () => void;
    resumeSessionId?: string | null;
    sessionId?: string;
    extraActionChips?: readonly AgentInputExtraActionChip[];
    /** The action menu's own trigger, handed to items that open a native dialog. */
    actionMenuAnchorRef?: FocusReturnRef;
    dismissActionMenu: () => void;
    blurInput: () => void;
    openCollapsedOptionsPopover: (chipKey: string | null) => void;
    resetCorePopovers: () => void;
    onProfileClick?: () => void;
    onEnvVarsClick?: () => void;
    onAgentClick?: () => void;
    permissionLabel?: string | null;
    onPermissionClick?: () => void;
    sessionModeLabel?: string | null;
    onSessionModeClick?: () => void;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    onResumeClick?: () => void;
    onFileViewerPress?: () => void;
}>): () => ReadonlyArray<AgentInputActionMenuAction> {
    return React.useCallback(() => {
        const overflowIds = new Set(params.resolvedControls.collapsed);
        const extraControlActions = buildCollapsedExtraControlActions({
            chips: params.extraActionChips?.filter((chip) => chip.placement && overflowIds.has(chip.placement.id)),
            tint: params.tint,
            dismiss: params.dismissActionMenu,
            blurInput: params.blurInput,
            openCollapsedOptionsPopover: (chipKey) => params.openCollapsedOptionsPopover(chipKey),
            resetCorePopovers: params.resetCorePopovers,
            ...(params.actionMenuAnchorRef ? { focusReturnRef: params.actionMenuAnchorRef } : {}),
        });

        return buildAgentInputActionMenuActions({
            resolvedControls: params.resolvedControls,
            tint: params.tint,
            agentId: params.agentId,
            agentIdentityIcon: params.agentIdentityIcon,
            profileLabel: params.profileLabel,
            profileIcon: params.profileIcon,
            envVarsCount: params.envVarsCount,
            agentLabel: params.agentLabel,
            engineLabel: params.engineLabel,
            machineName: params.machineName,
            currentPath: params.currentPath,
            folderChipState: params.folderChipState,
            onRemoveFolder: params.onRemoveFolder,
            resumeSessionId: params.resumeSessionId,
            sessionId: params.sessionId,
            onProfileClick: params.onProfileClick,
            onEnvVarsClick: params.onEnvVarsClick,
            onAgentClick: params.onAgentClick,
            permissionLabel: params.permissionLabel,
            onPermissionClick: params.onPermissionClick,
            sessionModeLabel: params.sessionModeLabel,
            onSessionModeClick: params.onSessionModeClick,
            onMachineClick: params.onMachineClick,
            onPathClick: params.onPathClick,
            onResumeClick: params.onResumeClick,
            onFileViewerPress: params.onFileViewerPress,
            extraControlActions,
            dismiss: params.dismissActionMenu,
            blurInput: params.blurInput,
        });
    }, [
        params.resolvedControls,
        params.actionMenuAnchorRef,
        params.agentId,
        params.agentIdentityIcon,
        params.agentLabel,
        params.engineLabel,
        params.blurInput,
        params.currentPath,
        params.folderChipState,
        params.onRemoveFolder,
        params.dismissActionMenu,
        params.envVarsCount,
        params.extraActionChips,
        params.machineName,
        params.onAgentClick,
        params.permissionLabel,
        params.onPermissionClick,
        params.onEnvVarsClick,
        params.onFileViewerPress,
        params.onMachineClick,
        params.onPathClick,
        params.onProfileClick,
        params.onResumeClick,
        params.onSessionModeClick,
        params.openCollapsedOptionsPopover,
        params.profileIcon,
        params.profileLabel,
        params.resetCorePopovers,
        params.resumeSessionId,
        params.sessionId,
        params.sessionModeLabel,
        params.tint,
    ]);
}
