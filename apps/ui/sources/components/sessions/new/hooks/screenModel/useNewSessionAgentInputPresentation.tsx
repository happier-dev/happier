import * as React from 'react';
import { View } from 'react-native';

import type { ActionId, BackendTargetRefV2, WindowsRemoteSessionLaunchMode } from '@happier-dev/protocol';
import type { Router } from 'expo-router';

import { useNewSessionCheckoutActionChip } from '@/components/sessions/new/hooks/screenModel/useNewSessionCheckoutActionChip';
import { useNewSessionAgentInputExtraActionChips } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentInputExtraActionChips';
import { getAutomationChipLabel } from '@/components/sessions/new/modules/automationChipModel';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import type { AgentId } from '@/agents/catalog/catalog';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { HandleCreateSessionOptions } from '@/components/sessions/new/hooks/useCreateNewSession';
import type { ScmWorkingSnapshot, Machine } from '@/sync/domains/state/storageTypes';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { NewSessionCheckoutChipModel } from '@/components/sessions/new/modules/newSessionCheckoutChipModel';
import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import type { NewSessionTranscriptStorage } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { t } from '@/text';
import { createNewSessionLinkedFilesActionChip } from '@/components/sessions/agentInput/definitions/createLinkedFilesActionChip';
import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getMachineDisplaySubtitle } from '@/sync/domains/machines/machineDisplayRenderable';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { createTemporaryComputerTeamAccessActionChip } from '@/components/sessions/agentInput/definitions/createTemporaryComputerTeamAccessActionChip';

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
    checkoutPickerOpen: boolean;
}>): string {
    try {
        return JSON.stringify({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            checkoutPickerOpen: params.checkoutPickerOpen,
            chips: params.chips.map((chip) => ({
                key: chip.key,
                stabilityKey: chip.stabilityKey ?? null,
                controlId: chip.controlId ?? null,
                labelPolicy: chip.labelPolicy ?? null,
                collapsedOptionsTitle: chip.collapsedOptionsPopover?.title ?? null,
                collapsedOptionsLabel: chip.collapsedOptionsPopover?.label ?? null,
                collapsedContentTitle: chip.collapsedContentPopover?.title ?? null,
                collapsedContentLabel: chip.collapsedContentPopover?.label ?? null,
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
    backendTarget: BackendTargetRefV2;
    agentType: string;
    staticAgentId: AgentId | null;
    /** The Agent that will run the Session; see the chips hook. */
    runtimeCarrierAgentId: string | null;
    agentOptionState?: Record<string, unknown> | null;
    setAgentOptionStateForCurrentAgent: (key: string, next: unknown) => void;
    connectedServicesAuthChip?: AgentInputExtraActionChip | null;
    /** One-shot unresolved placement offered by a host-seeded New Session draft. */
    seededPlacementActionChip?: AgentInputExtraActionChip | null;
    organizationPlacementActionChips?: readonly AgentInputExtraActionChip[];
    sessionAccess?: Parameters<typeof useNewSessionAgentInputExtraActionChips>[0]['sessionAccess'];
    showAutomationActionChips: boolean;
    showInitialTriggers?: Parameters<typeof useNewSessionAgentInputExtraActionChips>[0]['showInitialTriggers'];
    initialTriggers?: Parameters<typeof useNewSessionAgentInputExtraActionChips>[0]['initialTriggers'];
    onInitialTriggersChange?: Parameters<typeof useNewSessionAgentInputExtraActionChips>[0]['onInitialTriggersChange'];
    /** Hands the composed draft to the shared Automation editor. */
    onOpenAutomationEditor: () => void;
    showServerPickerChip: boolean;
    targetServerId: string | null;
    targetServerName: string;
    mcpChip?: AgentInputExtraActionChip | null;
    externalSessionsFeatureEnabled: boolean;
    supportsDirectTranscriptStorage: boolean;
    transcriptStorage: NewSessionTranscriptStorage;
    hasUserSelectedTranscriptStorageRef: React.MutableRefObject<boolean>;
    setTranscriptStorage: React.Dispatch<React.SetStateAction<NewSessionTranscriptStorage>>;
    selectedMachineIsWindows: boolean;
    effectiveWindowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchMode | null;
    windowsTerminalAvailable: boolean;
    setWindowsRemoteSessionLaunchModeOverride: (mode: WindowsRemoteSessionLaunchMode | null) => void;
    temporaryComputerTeamAccess?: Readonly<{
        authorized: boolean;
        onChange: (authorized: boolean) => void;
    }> | null;
}>): Readonly<{
    connectionStatus: Readonly<{
        text: string;
        color: string;
        dotColor: string;
        isPulsing: boolean;
        healthy: boolean;
        recovery?: 'machine';
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
    const selectedMachineLabel = getMachineDisplaySubtitle(params.selectedMachine ?? undefined, params.selectedMachineId ?? '');
    const connectionStatus = React.useMemo(() => {
        if (!params.selectedMachineId) return undefined;
        if (!params.selectedMachine) {
            return {
                text: t('newSession.machineUnavailableStatus'),
                color: params.theme.colors.state.danger.foreground,
                dotColor: params.theme.colors.state.danger.foreground,
                isPulsing: false,
                healthy: false,
                recovery: 'machine' as const,
            };
        }
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
            text: online ? t('status.online') : selectedMachineReadinessStatus === 'keyUnavailable'
                ? t('machineRequester.keyPending', { machine: selectedMachineLabel })
                : t('newSession.machineOfflineInlineTitle'),
            color: online ? params.theme.colors.state.success.foreground : params.theme.colors.state.danger.foreground,
            dotColor: online ? params.theme.colors.state.success.foreground : params.theme.colors.state.danger.foreground,
            isPulsing: online,
            healthy: online,
            ...(online ? {} : { recovery: 'machine' as const }),
        };
    }, [
        params.selectedMachine?.id,
        params.selectedMachineId,
        selectedMachineOnline,
        selectedMachineReadinessStatus,
        selectedMachineLabel,
        params.theme.colors.state.success.foreground,
        params.theme.colors.state.danger.foreground,
    ]);


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
        serverId: params.targetServerId,
        selectedMachineId: params.selectedMachineId,
        machineHomeDir: params.selectedMachine?.metadata?.homeDir ?? null,
        machinePlatform: params.selectedMachine?.metadata?.platform ?? null,
        selectedPath: params.selectedPath,
        setSelectedPath: params.setSelectedPath,
        setCheckoutCreationDraft: params.setCheckoutCreationDraft,
        pendingGitWorktreeBaseRefRef: params.pendingGitWorktreeBaseRefRef,
        pendingGitWorktreeSourceKindRef: params.pendingGitWorktreeSourceKindRef,
        shouldReconcileInitialHydratedCheckoutCreationDraftRef: params.shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        router: params.router,
    });

    const actionDraftAccountScope = useActiveServerAccountScope();
    const handleActionShortcutPress = React.useCallback((actionId: ActionId) => {
        const instructions = params.promptStore.getPrompt();
        params.handleCreateSession({
            initialMessage: 'skip',
            afterCreated: async ({ sessionId }) => {
                if (!actionDraftAccountScope || actionDraftAccountScope.serverId !== params.targetServerId) return;
                const input = buildExecutionRunActionDraftInputForUi({
                    actionId,
                    sessionId,
                    defaultBackendTarget: params.backendTarget,
                    defaultBackendId: params.agentType,
                    instructions,
                });
                storage.getState().createSessionActionDraft(
                    actionDraftAccountScope,
                    { serverId: actionDraftAccountScope.serverId, sessionId },
                    { actionId, input },
                );
            },
        });
    }, [actionDraftAccountScope, params.agentType, params.backendTarget, params.handleCreateSession, params.promptStore, params.targetServerId]);

    const agentInputExtraActionChips = useNewSessionAgentInputExtraActionChips({
        staticAgentId: params.staticAgentId,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        agentOptionState: params.agentOptionState,
        setAgentOptionState: params.setAgentOptionStateForCurrentAgent,
        selectedMachineId: params.selectedMachineId,
        connectedServicesAuthChip: params.connectedServicesAuthChip,
        seededPlacementActionChip: params.seededPlacementActionChip,
        showAutomationActionChips: params.showAutomationActionChips,
        showInitialTriggers: params.showInitialTriggers,
        initialTriggers: params.initialTriggers,
        onInitialTriggersChange: params.onInitialTriggersChange,
        automationLabel: getAutomationChipLabel(params.automationDraft),
        onOpenAutomationEditor: params.onOpenAutomationEditor,
        checkoutActionChip,
        organizationPlacementActionChips: params.organizationPlacementActionChips,
        sessionAccess: params.sessionAccess,
        showServerPickerChip: params.showServerPickerChip,
        targetServerId: params.targetServerId,
        targetServerName: params.targetServerName,
        mcpChip: params.mcpChip,
        externalSessionsFeatureEnabled: params.externalSessionsFeatureEnabled,
        supportsDirectTranscriptStorage: params.supportsDirectTranscriptStorage,
        transcriptStorage: params.transcriptStorage,
        onTranscriptStorageChange: handleTranscriptStorageChange,
        selectedMachineIsWindows: params.selectedMachineIsWindows,
        windowsRemoteSessionLaunchMode: params.effectiveWindowsRemoteSessionLaunchMode,
        windowsTerminalAvailable: params.windowsTerminalAvailable,
        onWindowsRemoteSessionLaunchModeChange: params.setWindowsRemoteSessionLaunchModeOverride,
        onActionShortcutPress: handleActionShortcutPress,
    });
    const temporaryComputerTeamAccessChip = React.useMemo(
        () => params.temporaryComputerTeamAccess
            ? createTemporaryComputerTeamAccessActionChip(params.temporaryComputerTeamAccess)
            : null,
        [params.temporaryComputerTeamAccess],
    );
    const combinedExtraActionChips = React.useMemo(
        () => [
            linkFileChip,
            ...(temporaryComputerTeamAccessChip ? [temporaryComputerTeamAccessChip] : []),
            ...agentInputExtraActionChips,
        ],
        [agentInputExtraActionChips, linkFileChip, temporaryComputerTeamAccessChip],
    );
    const combinedExtraActionChipsSignature = React.useMemo(() => buildExtraActionChipsSignature({
        chips: combinedExtraActionChips,
        agentType: params.agentType,
        backendTarget: params.backendTarget,
        checkoutPickerOpen: params.checkoutPickerOpen,
    }), [combinedExtraActionChips, params.agentType, params.backendTarget, params.checkoutPickerOpen]);
    const stableExtraActionChips = useStableExtraActionChips(
        combinedExtraActionChips,
        combinedExtraActionChipsSignature,
    );

    return React.useMemo(() => ({
        connectionStatus,
        agentInputExtraActionChips: stableExtraActionChips,
    }), [connectionStatus, stableExtraActionChips]);
}
