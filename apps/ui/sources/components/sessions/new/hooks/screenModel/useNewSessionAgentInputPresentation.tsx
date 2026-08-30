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
import type { HandleCreateSessionOptions } from '@/components/sessions/new/hooks/useCreateNewSession';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { ScmWorkingSnapshot, Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import type { NewSessionCheckoutChipModel } from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { t } from '@/text';
import { createNewSessionLinkedFilesActionChip } from '@/components/sessions/agentInput/definitions/createLinkedFilesActionChip';
import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

type ThemeLike = Readonly<{
    colors: Readonly<{
        state: Readonly<{
            success: Readonly<{ foreground: string }>;
            danger: Readonly<{ foreground: string }>;
        }>;
    }>;
}>;

export function buildExtraActionChipsSignature(params: Readonly<{
    chips: ReadonlyArray<AgentInputExtraActionChip>;
    agentType: string;
    backendTarget: unknown;
}>): string {
    try {
        return JSON.stringify({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            chips: params.chips.map((chip) => ({
                key: chip.key,
                stabilityKey: chip.stabilityKey ?? null,
                controlId: chip.controlId ?? null,
                labelPolicy: chip.labelPolicy ?? null,
                collapsedOptionsTitle: chip.collapsedOptionsPopover?.title ?? null,
                collapsedOptionsLabel: chip.collapsedOptionsPopover?.label ?? null,
                collapsedContentTitle: chip.collapsedContentPopover?.title ?? null,
                collapsedContentLabel: chip.collapsedContentPopover?.label ?? null,
                attachmentBadgeKey: chip.composerAttachmentBadge?.key ?? null,
                attachmentBadgeLabel: chip.composerAttachmentBadge?.label ?? null,
            })),
        }) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

function useStableExtraActionChips(
    chips: ReadonlyArray<AgentInputExtraActionChip>,
    signature: string,
): ReadonlyArray<AgentInputExtraActionChip> {
    const ref = React.useRef<Readonly<{ signature: string; chips: ReadonlyArray<AgentInputExtraActionChip> }> | null>(null);
    if (!ref.current || ref.current.signature !== signature) {
        ref.current = { signature, chips };
    }
    return ref.current.chips;
}

export function useNewSessionAgentInputPresentation(params: Readonly<{
    theme: ThemeLike;
    selectedMachine: Machine | null;
    selectedMachineSpawnReadiness?: MachineSpawnReadiness | null;
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
    promptStore: NewSessionPromptStore;
    setSessionPrompt: React.Dispatch<React.SetStateAction<string>>;
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
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
    /** The removable "continue from this Session" chip, when one is attached. */
    sourceContextChip?: AgentInputExtraActionChip | null;
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
    agentInputExtraActionChips: ReadonlyArray<AgentInputExtraActionChip>;
}> {
    const selectedMachineActive = params.selectedMachine?.active;
    const selectedMachineActiveAt = params.selectedMachine?.activeAt;
    const selectedMachineRevokedAt = params.selectedMachine?.revokedAt;
    const selectedMachineReplacedByMachineId = params.selectedMachine?.replacedByMachineId;
    const selectedMachineOnline = React.useMemo(() => (
        params.selectedMachine ? isMachineOnline(params.selectedMachine) : false
    ), [
        params.selectedMachine?.id,
        selectedMachineActive,
        selectedMachineActiveAt,
        selectedMachineReplacedByMachineId,
        selectedMachineRevokedAt,
    ]);
    const selectedMachineReadinessStatus = params.selectedMachineSpawnReadiness?.status;
    const connectionStatus = React.useMemo(() => {
        if (!params.selectedMachine) return undefined;
        const online = selectedMachineReadinessStatus === 'ready'
            || (
                (
                    selectedMachineReadinessStatus === undefined
                    || selectedMachineReadinessStatus === 'unknown'
                    || selectedMachineReadinessStatus === 'probing'
                )
                && selectedMachineOnline
            );

        return {
            text: online ? t('status.online') : t('newSession.machineOfflineCannotStartStatus'),
            color: online ? params.theme.colors.state.success.foreground : params.theme.colors.state.danger.foreground,
            dotColor: online ? params.theme.colors.state.success.foreground : params.theme.colors.state.danger.foreground,
            isPulsing: online,
        };
    }, [
        params.selectedMachine?.id,
        selectedMachineOnline,
        selectedMachineReadinessStatus,
        params.theme.colors.state.success.foreground,
        params.theme.colors.state.danger.foreground,
    ]);

    const handleAutomationSettingsChange = React.useCallback((next: AutomationSettingsValue) => {
        params.setAutomationDraft(sanitizeNewSessionAutomationDraft(next));
    }, [params.setAutomationDraft]);

    const handleAppendLinkedPath = React.useCallback((path: string) => {
        const base = params.promptStore.getPrompt();
        const spacer = base.length === 0 || base.endsWith(' ') || base.endsWith('\n') ? '' : ' ';
        params.setSessionPrompt(`${base}${spacer}@${path} `);
    }, [params.promptStore, params.setSessionPrompt]);

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
        // R16b: thread the machine's canonical home directory so the worktree picker
        // can canonicalize tilde-prefixed paths (R10 contract). Defaults to null when the
        // selected machine hasn't reported metadata yet.
        machineHomeDir: params.selectedMachine?.metadata?.homeDir ?? null,
    });

    const handleActionShortcutPress = React.useCallback((actionId: ActionId) => {
        const instructions = params.promptStore.getPrompt();
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
    }, [params.agentType, params.backendTarget, params.handleCreateSession, params.promptStore]);

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
        sourceContextChip: params.sourceContextChip,
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
    const combinedExtraActionChips = React.useMemo(
        () => [linkFileChip, ...agentInputExtraActionChips],
        [agentInputExtraActionChips, linkFileChip],
    );
    const combinedExtraActionChipsSignature = React.useMemo(() => buildExtraActionChipsSignature({
        chips: combinedExtraActionChips,
        agentType: params.agentType,
        backendTarget: params.backendTarget,
    }), [combinedExtraActionChips, params.agentType, params.backendTarget]);
    const stableExtraActionChips = useStableExtraActionChips(
        combinedExtraActionChips,
        combinedExtraActionChipsSignature,
    );

    return React.useMemo(() => ({
        connectionStatus,
        agentInputExtraActionChips: stableExtraActionChips,
    }), [connectionStatus, stableExtraActionChips]);
}
