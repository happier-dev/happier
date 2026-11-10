import type { AgentInputFolderChipState } from '../definitions/AgentInputFolderChip';
import * as React from 'react';

import { hapticsLight } from '@/components/ui/theme/haptics';

import type { ChipOptionInteraction } from '../chipOptionInteraction';
import type { AgentInputExtraActionChip, AgentInputPopoverAnchor } from '../agentInputContracts';
import { useAgentInputActionMenuActions } from './useAgentInputActionMenuActions';
import type { AgentInputSelectionOverlayId } from '../selection/agentInputSelectionOverlayTypes';
import type { IconName } from '@/components/ui/icons/Icon';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import type { AgentInputResolvedControlLines } from './agentInputControlTypes';
import type { AgentInputActionMenuAction } from '../actionMenuActions';

const EMPTY_ACTIONS: readonly AgentInputActionMenuAction[] = [];

export function useAgentInputActionMenuControls(params: Readonly<{
    resolvedControls: AgentInputResolvedControlLines;
    canCustomizeComposer?: boolean;
    /** The + menu is presented: opened on purpose, or held open by the picker its row opened beside it. */
    actionMenuOpen: boolean;
    setShowActionMenu: React.Dispatch<React.SetStateAction<boolean>>;
    closeSelectionOverlay: (id?: AgentInputSelectionOverlayId) => void;
    openSelectionOverlay: (
        id: AgentInputSelectionOverlayId,
        anchor: AgentInputPopoverAnchor,
        chipKey?: string,
    ) => void;
    resetSelectionOverlays: () => void;
    inputRef: React.RefObject<{ blur?: () => void } | null>;
    profilePopover?: unknown;
    onProfileClick?: () => void;
    envVarsPopover?: unknown;
    onEnvVarsClick?: () => void;
    machinePopover?: unknown;
    pathPopover?: unknown;
    resumePopover?: unknown;
    hasAgentPickerOptions: boolean;
    onAgentClick?: () => void;
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
    /** The action menu's own anchor, so a dialog opened from it can return focus there. */
    actionMenuAnchorRef?: FocusReturnRef;
    openCollapsedOptionsPopover: (chipKey: string | null) => void;
    sessionModeLabel?: string | null;
    permissionLabel?: string | null;
    onPermissionClick?: () => void;
    /** The permission row opens the permission picker (rather than the host's own permission action). */
    permissionOpensPicker?: boolean;
    sessionModeChipInteraction?: ChipOptionInteraction<string> | null;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    onResumeClick?: () => void;
    onFileViewerPress?: () => void;
    hasProfile: boolean;
    hasEnvVars: boolean;
    hasAgent: boolean;
}>): Readonly<{
    handleActionMenuPress: () => void;
    actionMenuActions: readonly AgentInputActionMenuAction[];
    hasActionMenuPopoverSections: boolean;
}> {
    const dismissActionMenu = React.useCallback(() => {
        params.setShowActionMenu(false);
    }, [params.setShowActionMenu]);

    const blurComposerInput = React.useCallback(() => {
        params.inputRef.current?.blur?.();
    }, [params.inputRef]);

    const handleActionMenuPress = React.useCallback(() => {
        hapticsLight();
        if (params.actionMenuOpen) {
            // Closing the + menu closes the picker open beside it too.
            params.setShowActionMenu(false);
            params.closeSelectionOverlay();
            return;
        }
        params.closeSelectionOverlay('permission');
        params.setShowActionMenu(true);
    }, [params.actionMenuOpen, params.closeSelectionOverlay, params.setShowActionMenu]);

    // Which + menu rows open a picker beside the menu (a submenu: hover intent, Right) rather than act.
    // The row handlers below decide with these same facts.
    const opensPicker = {
        engine: params.hasAgentPickerOptions,
        permission: params.permissionOpensPicker === true,
        profile: Boolean(params.profilePopover),
        env: Boolean(params.envVarsPopover),
        mode: params.sessionModeChipInteraction?.kind === 'picker',
        machine: Boolean(params.machinePopover),
        path: Boolean(params.pathPopover),
        resume: Boolean(params.resumePopover),
    } as const;
    const pickerControlIds = React.useMemo(() => new Set(
        (Object.keys(opensPicker) as Array<keyof typeof opensPicker>).filter((id) => opensPicker[id]),
    ), [opensPicker.engine, opensPicker.permission, opensPicker.profile, opensPicker.env, opensPicker.mode,
        opensPicker.machine, opensPicker.path, opensPicker.resume]);

    const handleActionMenuProfileClick = React.useCallback(() => {
        if (opensPicker.profile) {
            params.openSelectionOverlay('profile', 'actionMenuRow');
            return;
        }
        params.onProfileClick?.();
    }, [params.onProfileClick, params.openSelectionOverlay, opensPicker.profile]);

    const handleActionMenuEnvVarsClick = React.useCallback(() => {
        if (opensPicker.env) {
            params.openSelectionOverlay('envVars', 'actionMenuRow');
            return;
        }
        params.onEnvVarsClick?.();
    }, [opensPicker.env, params.onEnvVarsClick, params.openSelectionOverlay]);

    const handleActionMenuMachineClick = React.useCallback(() => {
        if (opensPicker.machine) {
            params.openSelectionOverlay('machine', 'actionMenuRow');
            return;
        }
        params.onMachineClick?.();
    }, [opensPicker.machine, params.onMachineClick, params.openSelectionOverlay]);

    const handleActionMenuPathClick = React.useCallback(() => {
        if (opensPicker.path) {
            params.openSelectionOverlay('path', 'actionMenuRow');
            return;
        }
        params.onPathClick?.();
    }, [params.onPathClick, params.openSelectionOverlay, opensPicker.path]);

    const handleActionMenuResumeClick = React.useCallback(() => {
        if (opensPicker.resume) {
            params.openSelectionOverlay('resume', 'actionMenuRow');
            return;
        }
        params.onResumeClick?.();
    }, [params.onResumeClick, params.openSelectionOverlay, opensPicker.resume]);

    const handleActionMenuAgentClick = React.useCallback(() => {
        if (opensPicker.engine) {
            params.closeSelectionOverlay('permission');
            params.openSelectionOverlay('agent', 'actionMenuRow');
            return;
        }
        params.onAgentClick?.();
    }, [params.closeSelectionOverlay, opensPicker.engine, params.onAgentClick, params.openSelectionOverlay]);

    const handleActionMenuSessionModeClick = React.useCallback(() => {
        if (!opensPicker.mode) {
            return;
        }
        params.closeSelectionOverlay('permission');
        params.openSelectionOverlay('sessionMode', 'actionMenuRow');
    }, [
        params.closeSelectionOverlay,
        params.openSelectionOverlay,
        opensPicker.mode,
    ]);

    const buildActionMenuActions = useAgentInputActionMenuActions({
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
        extraActionChips: params.extraActionChips,
        ...(params.actionMenuAnchorRef ? { actionMenuAnchorRef: params.actionMenuAnchorRef } : {}),
        dismissActionMenu,
        blurInput: blurComposerInput,
        openCollapsedOptionsPopover: params.openCollapsedOptionsPopover,
        resetCorePopovers: params.resetSelectionOverlays,
        onProfileClick: params.hasProfile ? handleActionMenuProfileClick : undefined,
        onEnvVarsClick: params.hasEnvVars ? handleActionMenuEnvVarsClick : undefined,
        onAgentClick: params.hasAgent ? handleActionMenuAgentClick : undefined,
        permissionLabel: params.permissionLabel,
        onPermissionClick: params.onPermissionClick,
        sessionModeLabel: params.sessionModeLabel,
        onSessionModeClick: params.sessionModeChipInteraction ? handleActionMenuSessionModeClick : undefined,
        onMachineClick: (params.onMachineClick || params.machinePopover) ? handleActionMenuMachineClick : undefined,
        onPathClick: (params.onPathClick || params.pathPopover) ? handleActionMenuPathClick : undefined,
        onResumeClick: (params.onResumeClick || params.resumePopover) ? handleActionMenuResumeClick : undefined,
        onFileViewerPress: params.onFileViewerPress,
        pickerControlIds,
    });

    const actionMenuActions = React.useMemo(() => params.actionMenuOpen ? buildActionMenuActions() : EMPTY_ACTIONS,
        [buildActionMenuActions, params.actionMenuOpen]);
    const hasActionMenuPopoverSections = params.resolvedControls.collapsed.length > 0 || params.canCustomizeComposer === true;

    React.useEffect(() => {
        if (!hasActionMenuPopoverSections && params.actionMenuOpen) {
            params.setShowActionMenu(false);
        }
    }, [hasActionMenuPopoverSections, params.setShowActionMenu, params.actionMenuOpen]);

    return {
        handleActionMenuPress,
        actionMenuActions,
        hasActionMenuPopoverSections,
    };
}
