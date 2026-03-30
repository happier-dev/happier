import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

import { buildAgentInputActionMenuActions } from '../actionMenuActions';
import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { buildCollapsedExtraControlActions } from './buildCollapsedExtraControlActions';

export function useAgentInputActionMenuActions(params: Readonly<{
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
    dismissActionMenu: () => void;
    blurInput: () => void;
    openCollapsedOptionsPopover: (chipKey: string | null) => void;
    resetCorePopovers: () => void;
    onProfileClick?: () => void;
    onEnvVarsClick?: () => void;
    onAgentClick?: () => void;
    sessionModeLabel?: string | null;
    onSessionModeClick?: () => void;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    onResumeClick?: () => void;
    onFileViewerPress?: () => void;
    canStop?: boolean;
    onStop?: () => void;
}>): ReadonlyArray<ActionListItem> {
    return React.useMemo(() => {
        const extraControlActions = buildCollapsedExtraControlActions({
            chips: params.extraActionChips,
            tint: params.tint,
            dismiss: params.dismissActionMenu,
            blurInput: params.blurInput,
            openCollapsedOptionsPopover: (chipKey) => params.openCollapsedOptionsPopover(chipKey),
            resetCorePopovers: params.resetCorePopovers,
        });

        return buildAgentInputActionMenuActions({
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
            onProfileClick: params.onProfileClick,
            onEnvVarsClick: params.onEnvVarsClick,
            onAgentClick: params.onAgentClick,
            sessionModeLabel: params.sessionModeLabel,
            onSessionModeClick: params.onSessionModeClick,
            onMachineClick: params.onMachineClick,
            onPathClick: params.onPathClick,
            onResumeClick: params.onResumeClick,
            onFileViewerPress: params.onFileViewerPress,
            canStop: params.canStop,
            onStop: params.onStop,
            extraControlActions,
            dismiss: params.dismissActionMenu,
            blurInput: params.blurInput,
        });
    }, [
        params.actionBarIsCollapsed,
        params.agentId,
        params.agentType,
        params.blurInput,
        params.canStop,
        params.currentPath,
        params.dismissActionMenu,
        params.envVarsCount,
        params.extraActionChips,
        params.hasAnyActions,
        params.machineName,
        params.onAgentClick,
        params.onEnvVarsClick,
        params.onFileViewerPress,
        params.onMachineClick,
        params.onPathClick,
        params.onProfileClick,
        params.onResumeClick,
        params.onSessionModeClick,
        params.onStop,
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
