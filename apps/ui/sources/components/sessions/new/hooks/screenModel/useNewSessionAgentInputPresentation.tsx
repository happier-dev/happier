import * as React from 'react';
import { View } from 'react-native';

import type { ActionId, BackendTargetRefV1, WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';
import type { Router } from 'expo-router';

import type { AutomationSettingsValue } from '@/components/automations/editor/AutomationSettingsForm';
import { useNewSessionCheckoutActionChip } from '@/components/sessions/new/hooks/screenModel/useNewSessionCheckoutActionChip';
import { useNewSessionAgentInputExtraActionChips } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentInputExtraActionChips';
import { getAutomationChipLabel } from '@/components/sessions/new/modules/automationChipModel';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { sanitizeNewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import type { AgentId } from '@/agents/catalog/catalog';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { ScmWorkingSnapshot, Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { storage } from '@/sync/domains/state/storage';
import type { NewSessionCheckoutChipModel } from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { t } from '@/text';
import { createNewSessionLinkedFilesActionChip } from '@/components/sessions/agentInput/definitions/createLinkedFilesActionChip';
import { AutomationSettingsPopoverContent } from '@/components/sessions/agentInput/components/AutomationSettingsPopoverContent';

type ThemeLike = Readonly<{
    colors: Readonly<{
        success: string;
        textDestructive: string;
    }>;
}>;

export function useNewSessionAgentInputPresentation(params: Readonly<{
    theme: ThemeLike;
    selectedMachine: Machine | null;
    automationFeatureEnabled: boolean;
    automationDraft: NewSessionAutomationDraft;
    effectiveAutomationDraft: AutomationSettingsValue;
    setAutomationDraft: React.Dispatch<React.SetStateAction<NewSessionAutomationDraft>>;
    repoScmSnapshot: ScmWorkingSnapshot | null;
    checkoutChipModel: NewSessionCheckoutChipModel;
    checkoutPickerOpen: boolean;
    setCheckoutPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
    checkoutCreationDraft: NewSessionCheckoutCreationDraft | null;
    selectedMachineId: string | null;
    selectedPath: string;
    setSelectedPath: React.Dispatch<React.SetStateAction<string>>;
    setCheckoutCreationDraft: React.Dispatch<React.SetStateAction<NewSessionCheckoutCreationDraft | null>>;
    pendingGitWorktreeBaseRefRef: React.MutableRefObject<string | null>;
    pendingGitWorktreeSourceKindRef: React.MutableRefObject<'current' | 'local' | 'remote'>;
    shouldReconcileInitialHydratedCheckoutCreationDraftRef: React.MutableRefObject<boolean>;
    router: Router;
    sessionPrompt: string;
    setSessionPrompt: React.Dispatch<React.SetStateAction<string>>;
    handleCreateSession: (opts?: Readonly<{ initialMessage?: 'send' | 'skip'; afterCreated?: (context: Readonly<{ sessionId: string }>) => void | Promise<void> }>) => void;
    backendTarget: BackendTargetRefV1;
    agentType: AgentId;
    agentOptionState?: Record<string, unknown> | null;
    setAgentOptionStateForCurrentAgent: (key: string, next: unknown) => void;
    connectedServicesAuthChip?: AgentInputExtraActionChip | null;
    showAutomationActionChips: boolean;
    showServerPickerChip: boolean;
    targetServerId: string | null;
    targetServerName: string;
    mcpChip?: AgentInputExtraActionChip | null;
    directSessionsFeatureEnabled: boolean;
    supportsDirectTranscriptStorage: boolean;
    transcriptStorage: NewSessionTranscriptStorage;
    hasUserSelectedTranscriptStorageRef: React.MutableRefObject<boolean>;
    setTranscriptStorage: React.Dispatch<React.SetStateAction<NewSessionTranscriptStorage>>;
    selectedMachineIsWindows: boolean;
    effectiveWindowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
    windowsTerminalAvailable: boolean;
    setWindowsRemoteSessionLaunchModeOverride: (mode: WindowsRemoteSessionLaunchMode | null) => void;
}>): Readonly<{
    connectionStatus: Readonly<{
        text: string;
        color: string;
        dotColor: string;
        isPulsing: boolean;
    }> | undefined;
    automationSection: React.ReactNode;
    agentInputExtraActionChips: ReadonlyArray<AgentInputExtraActionChip>;
}> {
    const connectionStatus = React.useMemo(() => {
        if (!params.selectedMachine) return undefined;
        const online = isMachineOnline(params.selectedMachine);

        return {
            text: online ? t('status.online') : t('newSession.machineOfflineCannotStartStatus'),
            color: online ? params.theme.colors.success : params.theme.colors.textDestructive,
            dotColor: online ? params.theme.colors.success : params.theme.colors.textDestructive,
            isPulsing: online,
        };
    }, [params.selectedMachine, params.theme.colors.success, params.theme.colors.textDestructive]);

    const handleAutomationSettingsChange = React.useCallback((next: AutomationSettingsValue) => {
        params.setAutomationDraft(sanitizeNewSessionAutomationDraft(next));
    }, [params.setAutomationDraft]);

    const automationSection = React.useMemo(() => {
        if (!params.automationFeatureEnabled) return null;
        if (!params.showAutomationActionChips) return null;
        return (
            <AutomationSettingsPopoverContent
                value={params.effectiveAutomationDraft}
                onChange={handleAutomationSettingsChange}
            />
        );
    }, [
        handleAutomationSettingsChange,
        params.automationFeatureEnabled,
        params.effectiveAutomationDraft,
        params.showAutomationActionChips,
    ]);

    const handleAppendLinkedPath = React.useCallback((path: string) => {
        const base = String(params.sessionPrompt ?? '');
        const spacer = base.length === 0 || base.endsWith(' ') || base.endsWith('\n') ? '' : ' ';
        params.setSessionPrompt(`${base}${spacer}@${path} `);
    }, [params.sessionPrompt, params.setSessionPrompt]);

    const linkFileChip = React.useMemo<AgentInputExtraActionChip>(() => {
        return createNewSessionLinkedFilesActionChip({
            machineId: params.selectedMachineId,
            serverId: params.targetServerId ?? null,
            rootDirectoryPath: params.selectedPath ?? null,
            disabled: false,
            onPickPath: handleAppendLinkedPath,
        });
    }, [handleAppendLinkedPath, params.selectedMachineId, params.selectedPath, params.targetServerId]);

    const handleTranscriptStorageChange = React.useCallback((next: 'direct' | 'persisted') => {
        params.hasUserSelectedTranscriptStorageRef.current = true;
        params.setTranscriptStorage(next);
    }, [params.hasUserSelectedTranscriptStorageRef, params.setTranscriptStorage]);

    const checkoutActionChip = useNewSessionCheckoutActionChip({
        repoScmSnapshot: params.repoScmSnapshot,
        checkoutChipModel: params.checkoutChipModel,
        checkoutPickerOpen: params.checkoutPickerOpen,
        setCheckoutPickerOpen: params.setCheckoutPickerOpen,
        checkoutCreationDraft: params.checkoutCreationDraft,
        selectedMachineId: params.selectedMachineId,
        selectedPath: params.selectedPath,
        setSelectedPath: params.setSelectedPath,
        setCheckoutCreationDraft: params.setCheckoutCreationDraft,
        pendingGitWorktreeBaseRefRef: params.pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef: params.pendingGitWorktreeSourceKindRef,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef: params.shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        router: params.router,
    });

    const handleActionShortcutPress = React.useCallback((actionId: ActionId) => {
        const instructions = String(params.sessionPrompt ?? '');
        params.handleCreateSession({
            initialMessage: 'skip',
            afterCreated: async ({ sessionId }) => {
                const input = buildExecutionRunActionDraftInputForUi({
                    actionId,
                    sessionId,
                    defaultBackendTarget: params.backendTarget,
                    defaultBackendId: params.agentType,
                    instructions,
                });
                storage.getState().createSessionActionDraft(sessionId, {
                    actionId,
                    input,
                });
            },
        });
    }, [params.agentType, params.backendTarget, params.handleCreateSession, params.sessionPrompt]);

    const agentInputExtraActionChips = useNewSessionAgentInputExtraActionChips({
        agentId: params.agentType,
        agentOptionState: params.agentOptionState,
        setAgentOptionState: params.setAgentOptionStateForCurrentAgent,
        connectedServicesAuthChip: params.connectedServicesAuthChip,
        showAutomationActionChips: params.showAutomationActionChips,
        automationDraft: params.effectiveAutomationDraft,
        automationLabel: getAutomationChipLabel(params.automationDraft),
        onAutomationChange: handleAutomationSettingsChange,
        checkoutActionChip,
        showServerPickerChip: params.showServerPickerChip,
        targetServerId: params.targetServerId,
        targetServerName: params.targetServerName,
        mcpChip: params.mcpChip,
        directSessionsFeatureEnabled: params.directSessionsFeatureEnabled,
        supportsDirectTranscriptStorage: params.supportsDirectTranscriptStorage,
        transcriptStorage: params.transcriptStorage,
        onTranscriptStorageChange: handleTranscriptStorageChange,
        selectedMachineIsWindows: params.selectedMachineIsWindows,
        windowsRemoteSessionLaunchMode: params.effectiveWindowsRemoteSessionLaunchMode,
        windowsTerminalAvailable: params.windowsTerminalAvailable,
        onWindowsRemoteSessionLaunchModeChange: params.setWindowsRemoteSessionLaunchModeOverride,
        onActionShortcutPress: handleActionShortcutPress,
    });

    return {
        connectionStatus,
        automationSection,
        agentInputExtraActionChips: [linkFileChip, ...agentInputExtraActionChips],
    };
}
