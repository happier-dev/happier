import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import { hapticsLight } from '@/components/ui/theme/haptics';

import type { ChipOptionInteraction } from '../chipOptionInteraction';
import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { useAgentInputActionMenuActions } from './useAgentInputActionMenuActions';
import type { AgentInputSelectionOverlayId } from '../selection/agentInputSelectionOverlayTypes';

export function useAgentInputActionMenuControls(params: Readonly<{
    showActionMenu: boolean;
    setShowActionMenu: React.Dispatch<React.SetStateAction<boolean>>;
    closeSelectionOverlay: (id?: AgentInputSelectionOverlayId) => void;
    openSelectionOverlay: (
        id: AgentInputSelectionOverlayId,
        anchor: 'chip' | 'actionMenu',
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
    actionBarIsCollapsed: boolean;
    hasAnyActions: boolean;
    tint: string;
    agentId: AgentId;
    profileLabel: string | null;
    profileIcon: string;
    envVarsCount?: number;
    agentType?: AgentId;
    machineName?: string | null;
    currentPath?: string | null;
    resumeSessionId?: string | null;
    sessionId?: string;
    extraActionChips?: readonly AgentInputExtraActionChip[];
    openCollapsedOptionsPopover: (chipKey: string | null) => void;
    sessionModeLabel?: string | null;
    sessionModeChipInteraction?: ChipOptionInteraction<string> | null;
    onSessionModeChange?: (modeId: string) => void;
    shouldExposeSessionModeAction: boolean;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    onResumeClick?: () => void;
    onFileViewerPress?: () => void;
    canStop: boolean;
    onStop: () => void;
    hasProfile: boolean;
    hasEnvVars: boolean;
    hasAgent: boolean;
}>): Readonly<{
    handleActionMenuPress: () => void;
    actionMenuActions: ReturnType<typeof useAgentInputActionMenuActions>;
    hasActionMenuPopoverSections: boolean;
}> {
    const dismissActionMenu = React.useCallback(() => {
        params.setShowActionMenu(false);
    }, [params]);

    const blurComposerInput = React.useCallback(() => {
        params.inputRef.current?.blur?.();
    }, [params.inputRef]);

    const handleActionMenuPress = React.useCallback(() => {
        hapticsLight();
        params.setShowActionMenu((prev) => {
            const next = !prev;
            if (next) {
                params.closeSelectionOverlay('permission');
            }
            return next;
        });
    }, [params.closeSelectionOverlay, params.setShowActionMenu]);

    const handleActionMenuProfileClick = React.useCallback(() => {
        if (params.profilePopover) {
            params.openSelectionOverlay('profile', 'actionMenu');
            return;
        }
        params.onProfileClick?.();
    }, [params.onProfileClick, params.openSelectionOverlay, params.profilePopover]);

    const handleActionMenuEnvVarsClick = React.useCallback(() => {
        if (params.envVarsPopover) {
            params.openSelectionOverlay('envVars', 'actionMenu');
            return;
        }
        params.onEnvVarsClick?.();
    }, [params.envVarsPopover, params.onEnvVarsClick, params.openSelectionOverlay]);

    const handleActionMenuMachineClick = React.useCallback(() => {
        if (params.machinePopover) {
            params.openSelectionOverlay('machine', 'actionMenu');
            return;
        }
        params.onMachineClick?.();
    }, [params.machinePopover, params.onMachineClick, params.openSelectionOverlay]);

    const handleActionMenuPathClick = React.useCallback(() => {
        if (params.pathPopover) {
            params.openSelectionOverlay('path', 'actionMenu');
            return;
        }
        params.onPathClick?.();
    }, [params.onPathClick, params.openSelectionOverlay, params.pathPopover]);

    const handleActionMenuResumeClick = React.useCallback(() => {
        if (params.resumePopover) {
            params.openSelectionOverlay('resume', 'actionMenu');
            return;
        }
        params.onResumeClick?.();
    }, [params.onResumeClick, params.openSelectionOverlay, params.resumePopover]);

    const handleActionMenuAgentClick = React.useCallback(() => {
        if (params.hasAgentPickerOptions) {
            params.closeSelectionOverlay('permission');
            params.openSelectionOverlay('agent', 'actionMenu');
            return;
        }
        params.onAgentClick?.();
    }, [params.closeSelectionOverlay, params.hasAgentPickerOptions, params.onAgentClick, params.openSelectionOverlay]);

    const handleActionMenuSessionModeClick = React.useCallback(() => {
        if (params.sessionModeChipInteraction?.kind === 'cycle') {
            params.onSessionModeChange?.(params.sessionModeChipInteraction.nextOptionId);
            return;
        }
        if (params.sessionModeChipInteraction?.kind !== 'picker') {
            return;
        }
        params.closeSelectionOverlay('permission');
        params.openSelectionOverlay('sessionMode', 'actionMenu');
    }, [
        params.closeSelectionOverlay,
        params.onSessionModeChange,
        params.openSelectionOverlay,
        params.sessionModeChipInteraction,
    ]);

    const actionMenuActions = useAgentInputActionMenuActions({
        actionBarIsCollapsed: params.actionBarIsCollapsed,
        hasAnyActions: params.hasAnyActions,
        tint: params.tint,
        agentId: params.agentId,
        profileLabel: params.profileLabel,
        profileIcon: params.profileIcon,
        envVarsCount: params.envVarsCount,
        agentType: params.agentType,
        machineName: params.machineName,
        currentPath: params.currentPath,
        resumeSessionId: params.resumeSessionId,
        sessionId: params.sessionId,
        extraActionChips: params.extraActionChips,
        dismissActionMenu,
        blurInput: blurComposerInput,
        openCollapsedOptionsPopover: params.openCollapsedOptionsPopover,
        resetCorePopovers: params.resetSelectionOverlays,
        onProfileClick: params.hasProfile ? handleActionMenuProfileClick : undefined,
        onEnvVarsClick: params.hasEnvVars ? handleActionMenuEnvVarsClick : undefined,
        onAgentClick: params.hasAgent ? handleActionMenuAgentClick : undefined,
        sessionModeLabel: params.shouldExposeSessionModeAction ? (params.sessionModeLabel ?? null) : null,
        onSessionModeClick: params.shouldExposeSessionModeAction ? handleActionMenuSessionModeClick : undefined,
        onMachineClick: (params.onMachineClick || params.machinePopover) ? handleActionMenuMachineClick : undefined,
        onPathClick: (params.onPathClick || params.pathPopover) ? handleActionMenuPathClick : undefined,
        onResumeClick: (params.onResumeClick || params.resumePopover) ? handleActionMenuResumeClick : undefined,
        onFileViewerPress: params.onFileViewerPress,
        canStop: params.canStop,
        onStop: params.onStop,
    });

    const hasActionMenuPopoverSections = actionMenuActions.length > 0;

    React.useEffect(() => {
        if (!hasActionMenuPopoverSections && params.showActionMenu) {
            params.setShowActionMenu(false);
        }
    }, [hasActionMenuPopoverSections, params.setShowActionMenu, params.showActionMenu]);

    return {
        handleActionMenuPress,
        actionMenuActions,
        hasActionMenuPopoverSections,
    };
}
