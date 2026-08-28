import * as React from 'react';
import type { ActionId, WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import {
    getNewSessionAgentInputExtraActionChips,
} from '@/agents/catalog/catalog';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createAutomationToggleActionChip } from '@/components/sessions/agentInput/definitions/createAutomationToggleActionChip';
import { createServerActionChip } from '@/components/sessions/agentInput/definitions/createServerActionChip';
import { createTranscriptStorageActionChip } from '@/components/sessions/agentInput/definitions/createTranscriptStorageActionChip';
import { createWindowsRemoteSessionLaunchModeActionChip } from '@/components/sessions/agentInput/definitions/createWindowsRemoteSessionLaunchModeActionChip';
import { buildNewSessionActionShortcutChips } from '@/components/sessions/agentInput/sessionActions/buildNewSessionActionShortcutChips';
import { NewSessionServerSelectionContent } from '@/components/sessions/new/components/NewSessionServerSelectionContent';
import { storage } from '@/sync/domains/state/storage';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { resolveNewSessionBehaviorAgentId } from '@/components/sessions/new/modules/newSessionBehaviorAgent';

export function useNewSessionAgentInputExtraActionChips(params: Readonly<{
    /** Explicit bundled behavior backing for built-in action chips. */
    staticAgentId?: AgentId | null;
    /**
     * The Agent that will actually run the Session. An installed Agent has no
     * bundled presentation id, so reading its declared chips from
     * `staticAgentId` answers `null` for every one of them; the operational
     * identity is what the descriptor owner is keyed by.
     */
    runtimeCarrierAgentId?: string | null;
    /** @deprecated Direct callers without a projected backend entry are bundled-only. */
    agentId?: AgentId;
    agentOptionState?: Record<string, unknown> | null;
    setAgentOptionState: (key: string, next: unknown) => void;
    /**
     * The machine the composer is about to spawn on. An installed Agent's
     * descriptor is a per-machine fact, so its declared chips are read from the
     * machine that will run the Session.
     */
    selectedMachineId: string | null;
    connectedServicesAuthChip?: AgentInputExtraActionChip | null;
    seededPlacementActionChip?: AgentInputExtraActionChip | null;
    showAutomationActionChips: boolean;
    automationDraft: NewSessionAutomationDraft;
    automationLabel: string;
    onAutomationChange: (next: NewSessionAutomationDraft) => void;
    checkoutActionChip?: AgentInputExtraActionChip | null;
    organizationPlacementActionChips?: readonly AgentInputExtraActionChip[];
    showServerPickerChip: boolean;
    targetServerId: string | null;
    targetServerName: string;
    mcpChip?: AgentInputExtraActionChip | null;
    externalSessionsFeatureEnabled: boolean;
    supportsDirectTranscriptStorage: boolean;
    transcriptStorage: NewSessionTranscriptStorage;
    onTranscriptStorageChange: (next: NewSessionTranscriptStorage) => void;
    selectedMachineIsWindows: boolean;
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
    windowsTerminalAvailable: boolean;
    onWindowsRemoteSessionLaunchModeChange: (next: WindowsRemoteSessionLaunchMode) => void;
    onActionShortcutPress: (actionId: ActionId) => void;
}>): ReadonlyArray<AgentInputExtraActionChip> {
    const staticAgentId = params.staticAgentId ?? params.agentId ?? null;
    const behaviorAgentId = resolveNewSessionBehaviorAgentId({
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        staticAgentId,
    });
    const serverPickerActionChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (!params.showServerPickerChip) return null;
        return createServerActionChip({
            label: params.targetServerName,
            popoverContent: ({ requestClose, maxHeight }) => (
                <NewSessionServerSelectionContent
                    maxHeight={Math.min(760, maxHeight)}
                    onClose={requestClose}
                    dismissOnSelection={true}
                    selectedServerId={params.targetServerId}
                />
            ),
            maxHeightCap: 760,
            maxWidthCap: 620,
        });
    }, [params.showServerPickerChip, params.targetServerId, params.targetServerName]);

    const automationActionChip = React.useMemo<AgentInputExtraActionChip>(() => {
        return createAutomationToggleActionChip({
            enabled: params.automationDraft.enabled,
            label: params.automationLabel,
            value: params.automationDraft,
            onChange: params.onAutomationChange,
            machineId: params.selectedMachineId,
            targetServerId: params.targetServerId,
        });
    }, [params.automationDraft, params.automationLabel, params.onAutomationChange, params.selectedMachineId, params.targetServerId]);

    const storageActionChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (!params.externalSessionsFeatureEnabled || !params.supportsDirectTranscriptStorage) return null;
        return createTranscriptStorageActionChip({
            transcriptStorage: params.transcriptStorage,
            onStorageChange: params.onTranscriptStorageChange,
        });
    }, [
        params.externalSessionsFeatureEnabled,
        params.onTranscriptStorageChange,
        params.supportsDirectTranscriptStorage,
        params.transcriptStorage,
    ]);

    return React.useMemo(() => {
        const baseChips = behaviorAgentId
            ? getNewSessionAgentInputExtraActionChips({
                agentId: behaviorAgentId,
                agentOptionState: params.agentOptionState,
                setAgentOptionState: params.setAgentOptionState,
                machineId: params.selectedMachineId,
            }) ?? []
            : [];
        const chips: AgentInputExtraActionChip[] = [];

        if (params.connectedServicesAuthChip) {
            chips.push(params.connectedServicesAuthChip);
        }
        if (params.checkoutActionChip) {
            chips.push(params.checkoutActionChip);
        }
        chips.push(...(params.organizationPlacementActionChips ?? []));
        if (params.showAutomationActionChips) {
            chips.push(automationActionChip);
        }
        if (params.seededPlacementActionChip) {
            chips.push(params.seededPlacementActionChip);
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
        params.agentOptionState,
        params.checkoutActionChip,
        params.connectedServicesAuthChip,
        params.mcpChip,
        params.organizationPlacementActionChips,
        params.seededPlacementActionChip,
        params.onActionShortcutPress,
        params.selectedMachineId,
        params.selectedMachineIsWindows,
        params.setAgentOptionState,
        params.showAutomationActionChips,
        params.windowsRemoteSessionLaunchMode,
        params.windowsTerminalAvailable,
        params.onWindowsRemoteSessionLaunchModeChange,
        automationActionChip,
        serverPickerActionChip,
        storageActionChip,
        behaviorAgentId,
    ]);
}
