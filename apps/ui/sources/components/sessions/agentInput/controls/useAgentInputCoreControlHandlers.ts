import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { hapticsLight } from '@/components/ui/theme/haptics';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { t } from '@/text';

import type { ChipOptionInteraction } from '../chipOptionInteraction';
import type { AgentInputContentPopoverConfig } from '../components/AgentInputContentPopover';
import type { AgentInputSelectionOverlayId } from '../selection/agentInputSelectionOverlayTypes';

function buildContentPopoverHandler(params: Readonly<{
    overlayId: Extract<AgentInputSelectionOverlayId, 'machine' | 'path' | 'resume' | 'profile' | 'envVars'>;
    popover?: AgentInputContentPopoverConfig;
    onLegacyClick?: () => void;
    toggleSelectionOverlay: (
        id: AgentInputSelectionOverlayId,
        anchor: 'chip' | 'actionMenu',
        chipKey?: string,
    ) => void;
}>): (() => void) | undefined {
    if (!params.popover && !params.onLegacyClick) {
        return undefined;
    }

    return () => {
        hapticsLight();
        if (params.popover) {
            params.toggleSelectionOverlay(params.overlayId, 'chip');
            return;
        }
        params.onLegacyClick?.();
    };
}

export function useAgentInputCoreControlHandlers(params: Readonly<{
    agentType?: AgentId;
    agentLabel?: string | null;
    hasAgentPickerOptions: boolean;
    onAgentClick?: () => void;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    onPermissionClick?: () => void;
    sessionModeChipInteraction?: ChipOptionInteraction<string> | null;
    onSessionModeChange?: (modeId: string) => void;
    profilePopover?: AgentInputContentPopoverConfig;
    onProfileClick?: () => void;
    envVarsPopover?: AgentInputContentPopoverConfig;
    onEnvVarsClick?: () => void;
    machinePopover?: AgentInputContentPopoverConfig;
    onMachineClick?: () => void;
    pathPopover?: AgentInputContentPopoverConfig;
    onPathClick?: () => void;
    resumePopover?: AgentInputContentPopoverConfig;
    onResumeClick?: () => void;
    setShowActionMenu: React.Dispatch<React.SetStateAction<boolean>>;
    closeSelectionOverlay: (id?: AgentInputSelectionOverlayId) => void;
    toggleSelectionOverlay: (
        id: AgentInputSelectionOverlayId,
        anchor: 'chip' | 'actionMenu',
        chipKey?: string,
    ) => void;
}>): Readonly<{
    hasAgentSelection: boolean;
    resolvedAgentLabel: string;
    handlePermissionPress: () => void;
    handleModePress: () => void;
    handleProfilePress: () => void;
    handleEnvVarsPress: () => void;
    handleAgentPress: () => void;
    handleMachinePress?: () => void;
    handlePathPress?: () => void;
    handleResumePress?: () => void;
}> {
    const hasAgentSelection = Boolean(params.agentType && (params.onAgentClick || params.hasAgentPickerOptions));

    const resolvedAgentLabel = React.useMemo(() => {
        return params.agentType
            ? (params.agentLabel ?? t(getAgentCore(params.agentType).displayNameKey))
            : '';
    }, [params.agentLabel, params.agentType]);

    const handlePermissionPress = React.useCallback(() => {
        hapticsLight();
        if (params.onPermissionModeChange) {
            params.setShowActionMenu(false);
            params.toggleSelectionOverlay('permission', 'chip');
            return;
        }
        params.onPermissionClick?.();
    }, [
        params.onPermissionClick,
        params.onPermissionModeChange,
        params.setShowActionMenu,
        params.toggleSelectionOverlay,
    ]);

    const handleModePress = React.useCallback(() => {
        hapticsLight();
        if (params.sessionModeChipInteraction?.kind === 'cycle') {
            params.onSessionModeChange?.(params.sessionModeChipInteraction.nextOptionId);
            return;
        }
        if (params.sessionModeChipInteraction?.kind === 'picker') {
            params.toggleSelectionOverlay('sessionMode', 'chip');
        }
    }, [params.onSessionModeChange, params.sessionModeChipInteraction, params.toggleSelectionOverlay]);

    const handleProfilePress = React.useCallback(() => {
        hapticsLight();
        if (params.profilePopover) {
            params.toggleSelectionOverlay('profile', 'chip');
            return;
        }
        params.onProfileClick?.();
    }, [params.onProfileClick, params.profilePopover, params.toggleSelectionOverlay]);

    const handleEnvVarsPress = React.useCallback(() => {
        hapticsLight();
        if (params.envVarsPopover) {
            params.toggleSelectionOverlay('envVars', 'chip');
            return;
        }
        params.onEnvVarsClick?.();
    }, [params.envVarsPopover, params.onEnvVarsClick, params.toggleSelectionOverlay]);

    const handleAgentPress = React.useCallback(() => {
        hapticsLight();
        if (params.hasAgentPickerOptions) {
            params.setShowActionMenu(false);
            params.closeSelectionOverlay('permission');
            params.toggleSelectionOverlay('agent', 'chip');
            return;
        }
        params.onAgentClick?.();
    }, [
        params.closeSelectionOverlay,
        params.hasAgentPickerOptions,
        params.onAgentClick,
        params.setShowActionMenu,
        params.toggleSelectionOverlay,
    ]);

    const handleMachinePress = React.useMemo(() => {
        return buildContentPopoverHandler({
            overlayId: 'machine',
            popover: params.machinePopover,
            onLegacyClick: params.onMachineClick,
            toggleSelectionOverlay: params.toggleSelectionOverlay,
        });
    }, [params.machinePopover, params.onMachineClick, params.toggleSelectionOverlay]);

    const handlePathPress = React.useMemo(() => {
        return buildContentPopoverHandler({
            overlayId: 'path',
            popover: params.pathPopover,
            onLegacyClick: params.onPathClick,
            toggleSelectionOverlay: params.toggleSelectionOverlay,
        });
    }, [params.onPathClick, params.pathPopover, params.toggleSelectionOverlay]);

    const handleResumePress = React.useMemo(() => {
        return buildContentPopoverHandler({
            overlayId: 'resume',
            popover: params.resumePopover,
            onLegacyClick: params.onResumeClick,
            toggleSelectionOverlay: params.toggleSelectionOverlay,
        });
    }, [params.onResumeClick, params.resumePopover, params.toggleSelectionOverlay]);

    return {
        hasAgentSelection,
        resolvedAgentLabel,
        handlePermissionPress,
        handleModePress,
        handleProfilePress,
        handleEnvVarsPress,
        handleAgentPress,
        handleMachinePress,
        handlePathPress,
        handleResumePress,
    };
}
