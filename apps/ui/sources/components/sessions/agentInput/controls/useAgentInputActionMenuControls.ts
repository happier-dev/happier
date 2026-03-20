import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import { hapticsLight } from '@/components/ui/theme/haptics';

import type { AgentInputExtraActionChip, AgentInputPopoverAnchor } from '../agentInputContracts';
import { useAgentInputActionMenuActions } from './useAgentInputActionMenuActions';

export function useAgentInputActionMenuControls(params: Readonly<{
    showActionMenu: boolean;
    setShowActionMenu: React.Dispatch<React.SetStateAction<boolean>>;
    setShowPermissionPopover: React.Dispatch<React.SetStateAction<boolean>>;
    setShowAgentPicker: React.Dispatch<React.SetStateAction<boolean>>;
    setShowSessionModePicker: React.Dispatch<React.SetStateAction<boolean>>;
    setShowProfilePopover: React.Dispatch<React.SetStateAction<boolean>>;
    setShowEnvVarsPopover: React.Dispatch<React.SetStateAction<boolean>>;
    setProfilePopoverAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    setEnvVarsPopoverAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    setAgentPickerAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    setSessionModePickerAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    inputRef: React.RefObject<{ blur?: () => void } | null>;
    profilePopover?: unknown;
    onProfileClick?: () => void;
    envVarsPopover?: unknown;
    onEnvVarsClick?: () => void;
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

    const resetCorePopovers = React.useCallback(() => {
        params.setShowPermissionPopover(false);
        params.setShowAgentPicker(false);
        params.setShowSessionModePicker(false);
        params.setShowProfilePopover(false);
        params.setShowEnvVarsPopover(false);
    }, [
        params.setShowAgentPicker,
        params.setShowEnvVarsPopover,
        params.setShowPermissionPopover,
        params.setShowProfilePopover,
        params.setShowSessionModePicker,
    ]);

    const handleActionMenuPress = React.useCallback(() => {
        hapticsLight();
        params.setShowActionMenu((prev) => {
            const next = !prev;
            if (next) {
                params.setShowPermissionPopover(false);
            }
            return next;
        });
    }, [params.setShowActionMenu, params.setShowPermissionPopover]);

    const handleActionMenuProfileClick = React.useCallback(() => {
        if (params.profilePopover) {
            params.setProfilePopoverAnchor('actionMenu');
            params.setShowProfilePopover(true);
            return;
        }
        params.onProfileClick?.();
    }, [params]);

    const handleActionMenuEnvVarsClick = React.useCallback(() => {
        if (params.envVarsPopover) {
            params.setEnvVarsPopoverAnchor('actionMenu');
            params.setShowEnvVarsPopover(true);
            return;
        }
        params.onEnvVarsClick?.();
    }, [params]);

    const handleActionMenuAgentClick = React.useCallback(() => {
        if (params.hasAgentPickerOptions) {
            params.setAgentPickerAnchor('actionMenu');
            params.setShowPermissionPopover(false);
            params.setShowAgentPicker(true);
            return;
        }
        params.onAgentClick?.();
    }, [params]);

    const handleActionMenuSessionModeClick = React.useCallback(() => {
        params.setSessionModePickerAnchor('actionMenu');
        params.setShowPermissionPopover(false);
        params.setShowSessionModePicker(true);
    }, [
        params.setSessionModePickerAnchor,
        params.setShowPermissionPopover,
        params.setShowSessionModePicker,
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
        resetCorePopovers,
        onProfileClick: params.hasProfile ? handleActionMenuProfileClick : undefined,
        onEnvVarsClick: params.hasEnvVars ? handleActionMenuEnvVarsClick : undefined,
        onAgentClick: params.hasAgent ? handleActionMenuAgentClick : undefined,
        sessionModeLabel: params.shouldExposeSessionModeAction ? (params.sessionModeLabel ?? null) : null,
        onSessionModeClick: params.shouldExposeSessionModeAction ? handleActionMenuSessionModeClick : undefined,
        onMachineClick: params.onMachineClick,
        onPathClick: params.onPathClick,
        onResumeClick: params.onResumeClick,
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
