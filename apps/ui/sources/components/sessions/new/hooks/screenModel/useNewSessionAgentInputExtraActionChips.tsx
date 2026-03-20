import * as React from 'react';
import type { ActionId, WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import {
    getNewSessionAgentInputExtraActionChips,
} from '@/agents/catalog/catalog';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createAutomationToggleActionChip } from '@/components/sessions/agentInput/definitions/createAutomationToggleActionChip';
import { createServerActionChip } from '@/components/sessions/agentInput/definitions/createServerActionChip';
import { createTranscriptStorageActionChip } from '@/components/sessions/agentInput/definitions/createTranscriptStorageActionChip';
import { createWindowsRemoteSessionLaunchModeActionChip } from '@/components/sessions/agentInput/definitions/createWindowsRemoteSessionLaunchModeActionChip';
import { buildNewSessionActionShortcutChips } from '@/components/sessions/agentInput/sessionActions/buildNewSessionActionShortcutChips';
import { storage } from '@/sync/domains/state/storage';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';

export function useNewSessionAgentInputExtraActionChips(params: Readonly<{
    agentId: AgentId;
    agentOptionState?: Record<string, unknown> | null;
    setAgentOptionState: (key: string, next: unknown) => void;
    connectedServicesAuthChip?: AgentInputExtraActionChip | null;
    showAutomationActionChips: boolean;
    automationEnabled: boolean;
    automationLabel: string;
    onAutomationToggle: (next: boolean) => void;
    checkoutActionChip?: AgentInputExtraActionChip | null;
    showServerPickerChip: boolean;
    targetServerName: string;
    onServerClick: () => void;
    mcpChip?: AgentInputExtraActionChip | null;
    directSessionsFeatureEnabled: boolean;
    supportsDirectTranscriptStorage: boolean;
    transcriptStorage: NewSessionTranscriptStorage;
    onToggleTranscriptStorage: () => void;
    selectedMachineIsWindows: boolean;
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
    windowsTerminalAvailable: boolean;
    onWindowsRemoteSessionLaunchModeChange: (next: WindowsRemoteSessionLaunchMode) => void;
    onActionShortcutPress: (actionId: ActionId) => void;
}>): ReadonlyArray<AgentInputExtraActionChip> {
    const serverPickerActionChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (!params.showServerPickerChip) return null;
        return createServerActionChip({
            label: params.targetServerName,
            onPress: params.onServerClick,
        });
    }, [params.onServerClick, params.showServerPickerChip, params.targetServerName]);

    const automationActionChip = React.useMemo<AgentInputExtraActionChip>(() => {
        return createAutomationToggleActionChip({
            enabled: params.automationEnabled,
            label: params.automationLabel,
            onValueChange: params.onAutomationToggle,
        });
    }, [params.automationEnabled, params.automationLabel, params.onAutomationToggle]);

    const storageActionChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (!params.directSessionsFeatureEnabled || !params.supportsDirectTranscriptStorage) return null;
        return createTranscriptStorageActionChip({
            transcriptStorage: params.transcriptStorage,
            onPress: params.onToggleTranscriptStorage,
        });
    }, [
        params.directSessionsFeatureEnabled,
        params.onToggleTranscriptStorage,
        params.supportsDirectTranscriptStorage,
        params.transcriptStorage,
    ]);

    return React.useMemo(() => {
        const baseChips = getNewSessionAgentInputExtraActionChips({
            agentId: params.agentId,
            agentOptionState: params.agentOptionState,
            setAgentOptionState: params.setAgentOptionState,
        }) ?? [];
        const chips: AgentInputExtraActionChip[] = [];

        if (params.connectedServicesAuthChip) {
            chips.push(params.connectedServicesAuthChip);
        }
        if (params.showAutomationActionChips) {
            chips.push(automationActionChip);
        }
        if (params.checkoutActionChip) {
            chips.push(params.checkoutActionChip);
        }
        if (serverPickerActionChip) {
            chips.push(serverPickerActionChip);
        }
        if (params.mcpChip) {
            chips.push(params.mcpChip);
        }
        if (storageActionChip) {
            chips.push(storageActionChip);
        }
        if (params.selectedMachineIsWindows && params.windowsRemoteSessionLaunchMode) {
            chips.push(createWindowsRemoteSessionLaunchModeActionChip({
                mode: params.windowsRemoteSessionLaunchMode,
                windowsTerminalAvailable: params.windowsTerminalAvailable,
                onModeChange: params.onWindowsRemoteSessionLaunchModeChange,
            }));
        }

        chips.push(...buildNewSessionActionShortcutChips({
            stateSnapshot: storage.getState(),
            onPressAction: params.onActionShortcutPress,
        }));

        return [...chips, ...baseChips];
    }, [
        params.agentId,
        params.agentOptionState,
        params.checkoutActionChip,
        params.connectedServicesAuthChip,
        params.mcpChip,
        params.onActionShortcutPress,
        params.selectedMachineIsWindows,
        params.setAgentOptionState,
        params.showAutomationActionChips,
        params.windowsRemoteSessionLaunchMode,
        params.windowsTerminalAvailable,
        params.onWindowsRemoteSessionLaunchModeChange,
        automationActionChip,
        serverPickerActionChip,
        storageActionChip,
    ]);
}
