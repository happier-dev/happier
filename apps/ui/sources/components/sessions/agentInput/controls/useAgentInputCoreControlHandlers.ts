import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { hapticsLight } from '@/components/ui/theme/haptics';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { t } from '@/text';

import type { AgentInputContentPopoverConfig } from '../components/AgentInputContentPopover';
import type { AgentInputPopoverAnchor } from '../agentInputContracts';

export function useAgentInputCoreControlHandlers(params: Readonly<{
    agentType?: AgentId;
    agentLabel?: string | null;
    hasAgentPickerOptions: boolean;
    onAgentClick?: () => void;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    onPermissionClick?: () => void;
    profilePopover?: AgentInputContentPopoverConfig;
    onProfileClick?: () => void;
    envVarsPopover?: AgentInputContentPopoverConfig;
    onEnvVarsClick?: () => void;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    setShowActionMenu: React.Dispatch<React.SetStateAction<boolean>>;
    setShowPermissionPopover: React.Dispatch<React.SetStateAction<boolean>>;
    setAgentPickerAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    setShowAgentPicker: React.Dispatch<React.SetStateAction<boolean>>;
    setSessionModePickerAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    setShowSessionModePicker: React.Dispatch<React.SetStateAction<boolean>>;
    setProfilePopoverAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    setShowProfilePopover: React.Dispatch<React.SetStateAction<boolean>>;
    setEnvVarsPopoverAnchor: React.Dispatch<React.SetStateAction<AgentInputPopoverAnchor>>;
    setShowEnvVarsPopover: React.Dispatch<React.SetStateAction<boolean>>;
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
            params.setShowPermissionPopover((current) => !current);
            return;
        }
        params.onPermissionClick?.();
    }, [
        params.onPermissionClick,
        params.onPermissionModeChange,
        params.setShowActionMenu,
        params.setShowPermissionPopover,
    ]);

    const handleModePress = React.useCallback(() => {
        hapticsLight();
        params.setSessionModePickerAnchor('chip');
        params.setShowSessionModePicker(true);
    }, [params.setSessionModePickerAnchor, params.setShowSessionModePicker]);

    const handleProfilePress = React.useCallback(() => {
        hapticsLight();
        if (params.profilePopover) {
            params.setProfilePopoverAnchor('chip');
            params.setShowProfilePopover((current) => !current);
            return;
        }
        params.onProfileClick?.();
    }, [
        params.onProfileClick,
        params.profilePopover,
        params.setProfilePopoverAnchor,
        params.setShowProfilePopover,
    ]);

    const handleEnvVarsPress = React.useCallback(() => {
        hapticsLight();
        if (params.envVarsPopover) {
            params.setEnvVarsPopoverAnchor('chip');
            params.setShowEnvVarsPopover((current) => !current);
            return;
        }
        params.onEnvVarsClick?.();
    }, [
        params.envVarsPopover,
        params.onEnvVarsClick,
        params.setEnvVarsPopoverAnchor,
        params.setShowEnvVarsPopover,
    ]);

    const handleAgentPress = React.useCallback(() => {
        hapticsLight();
        if (params.hasAgentPickerOptions) {
            params.setAgentPickerAnchor('chip');
            params.setShowActionMenu(false);
            params.setShowPermissionPopover(false);
            params.setShowAgentPicker(true);
            return;
        }
        params.onAgentClick?.();
    }, [
        params.hasAgentPickerOptions,
        params.onAgentClick,
        params.setAgentPickerAnchor,
        params.setShowActionMenu,
        params.setShowAgentPicker,
        params.setShowPermissionPopover,
    ]);

    const handleMachinePress = React.useMemo(() => {
        if (!params.onMachineClick) return undefined;
        return () => {
            hapticsLight();
            params.onMachineClick?.();
        };
    }, [params.onMachineClick]);

    const handlePathPress = React.useMemo(() => {
        if (!params.onPathClick) return undefined;
        return () => {
            hapticsLight();
            params.onPathClick?.();
        };
    }, [params.onPathClick]);

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
    };
}
