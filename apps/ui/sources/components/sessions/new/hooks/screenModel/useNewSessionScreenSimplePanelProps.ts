import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { useNewSessionSimplePanelProps } from '@/components/sessions/new/hooks/useNewSessionSimplePanelProps';
import type { MachinePoolSelectionOriginV1, SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { describeExecutionTargetDestination } from '@/components/sessions/new/hooks/temporaryComputerTargetPresentation';
import { t } from '@/text';

type ModelOptionsProbe = NonNullable<NewSessionSimplePanelProps['modelOptionsProbe']>;
type AcpSessionModeProbe = NonNullable<NewSessionSimplePanelProps['acpSessionModeProbe']>;
type AcpConfigOptionsProbe = NonNullable<NewSessionSimplePanelProps['acpConfigOptionsProbe']>;

type ModelOptionsProbeState = ModelOptionsProbe;

type AcpSessionModeProbeState = Readonly<{
    phase: AcpSessionModeProbe['phase'];
    onRefresh: AcpSessionModeProbe['onRefresh'];
}>;

type AcpConfigOptionsProbeState = Readonly<{
    phase: AcpConfigOptionsProbe['phase'];
    onRefresh: AcpConfigOptionsProbe['onRefresh'];
}>;

export function useNewSessionScreenSimplePanelProps(params: Readonly<{
    layout: Pick<
        NewSessionSimplePanelProps,
        | 'popoverBoundaryRef'
        | 'headerHeight'
        | 'safeAreaTop'
        | 'safeAreaBottom'
        | 'newSessionTopPadding'
        | 'newSessionSidePadding'
        | 'newSessionBottomPadding'
        | 'shouldBottomAnchor'
        | 'containerStyle'
    >;
    creation: Pick<
        NewSessionSimplePanelProps,
        | 'promptStore'
        | 'composerDocument'
        | 'composerReferenceHost'
        | 'composerFileScope'
        | 'setSessionPrompt'
        | 'handleCreateSession'
        | 'registerTemporaryComputerReplacementLaunch'
        | 'canCreate'
        | 'isCreating'
        | 'pendingLaunchAttempt'
        | 'launchPendingPreviewVisible'
        | 'providerLaunchError'
        | 'retryProviderLaunch'
        | 'submitAccessibilityLabel'
        | 'emptyAutocompleteKinds'
        | 'emptyAutocompleteSuggestions'
        | 'sessionPromptInputMaxHeight'
        | 'statusBadges'
        | 'composerTopContent'
        | 'statusTrailingActions'
    >;
    agent: Pick<
        NewSessionSimplePanelProps,
        | 'agentInputExtraActionChips'
        | 'sourceContextPresentation'
        | 'agentType'
        | 'agentLabel'
        | 'handleAgentClick'
        | 'agentPickerOptions'
        | 'onAgentPickerSelect'
        | 'agentPickerProbe'
        | 'onAgentPickerVisibilityChange'
    > & Readonly<{
        selectedBackendTargetKey: string;
        selectedBackendEntryTargetKey?: string;
        agentPickerSelectedOptionId?: string | null;
    }>;
    model: Pick<
        NewSessionSimplePanelProps,
        'permissionMode' | 'handlePermissionModeChange' | 'modelMode' | 'setModelMode' | 'modelOptions' | 'modelPickerProps'
    > & Readonly<{
        modelOptionsProbeState: ModelOptionsProbeState;
    }>;
    acp: Pick<
        NewSessionSimplePanelProps,
        | 'acpSessionModeOptions'
        | 'acpSessionModeId'
        | 'setAcpSessionModeId'
        | 'acpConfigOptions'
        | 'acpConfigOptionOverrides'
        | 'setAcpConfigOptionOverride'
    > & Readonly<{
        acpSessionModeProbeState: AcpSessionModeProbeState;
        acpConfigOptionsProbeState: AcpConfigOptionsProbeState;
    }>;
    machineAndResume: Pick<
        NewSessionSimplePanelProps,
        | 'connectionStatus'
        | 'machinePopover'
        | 'selectedMachineHomeDir'
        | 'selectedPath'
        | 'pathPopover'
        | 'folderChipState'
        | 'onRemoveFolder'
        | 'showResumePicker'
        | 'resumeSessionId'
        | 'resumePopover'
        | 'isResumeSupportChecking'
    > & Readonly<{
        machineDisplayName?: string;
        machineHost?: string;
        /**
         * The draft's committed target. A Temporary computer has no Machine to
         * name, so the composer chip must read it from here or keep telling the
         * author to "Select machine" for a destination they already chose.
         */
        executionTarget?: SessionAuthoringExecutionTargetV2 | null;
        destination?: Readonly<{
            selectionOrigin?: MachinePoolSelectionOriginV1;
            machineGroups: readonly Readonly<{ serverId: string; serverName: string }>[];
            poolGroups: readonly Readonly<{
                serverId: string;
                pools: readonly Readonly<{ pool: Readonly<{ id: string; name: string }> }>[];
            }>[];
        }>;
    }>;
    profile: Pick<NewSessionSimplePanelProps, 'useProfiles' | 'selectedProfileId' | 'selectedMachineId' | 'profilePopover'>;
    targetServerId: NewSessionSimplePanelProps['targetServerId'];
    attachmentFlowId: NewSessionSimplePanelProps['attachmentFlowId'];
}>): NewSessionSimplePanelProps {
    const { selectedBackendEntryTargetKey, selectedBackendTargetKey, agentPickerSelectedOptionId, ...agentProps } = params.agent;
    const { modelOptionsProbeState, ...modelProps } = params.model;
    const { acpSessionModeProbeState, acpConfigOptionsProbeState, ...acpProps } = params.acp;
    const {
        machineDisplayName,
        machineHost,
        destination,
        executionTarget,
        ...machineAndResumeProps
    } = params.machineAndResume;
    const temporaryComputerName = describeExecutionTargetDestination(executionTarget);
    const machineName = temporaryComputerName ?? getMachineDisplayName({
        id: params.profile.selectedMachineId,
        metadata: { displayName: machineDisplayName, host: machineHost },
    });
    const destinationParts = machineName ? [machineName] : [];
    const serverId = params.targetServerId;
    // Pool provenance and the Home prefix describe an exact Machine choice; a
    // Temporary computer has neither, so it keeps its own single-part label.
    if (temporaryComputerName === null && machineName && destination && serverId) {
        if (destination.machineGroups.some((group) => group.serverId !== serverId)) {
            destinationParts.unshift(destination.machineGroups.find((group) => group.serverId === serverId)?.serverName
                ?? serverId);
        }
        if (destination.selectionOrigin) {
            // Origin is informational. Only the selected Home's independently readable projection
            // can name it; restored drafts and Session metadata never carry a private Pool label.
            const poolName = destination.poolGroups.find((group) => group.serverId === serverId)
                ?.pools.find((view) => view.pool.id === destination.selectionOrigin?.poolId)?.pool.name.trim();
            destinationParts.unshift(`${t('machinePools.chosenFrom')}: ${poolName || t('machinePools.aMachinePool')}`);
        }
    }

    return useNewSessionSimplePanelProps({
        ...params.layout,
        ...params.creation,
        ...agentProps,
        ...modelProps,
        ...acpProps,
        ...machineAndResumeProps,
        ...params.profile,
        isTemporaryComputer: executionTarget?.kind === 'temporary_computer',
        targetServerId: params.targetServerId,
        attachmentFlowId: params.attachmentFlowId,
        agentPickerSelectedOptionId: agentPickerSelectedOptionId ?? selectedBackendEntryTargetKey ?? selectedBackendTargetKey,
        modelOptionsProbe: modelOptionsProbeState,
        acpSessionModeProbe: {
            phase: acpSessionModeProbeState.phase,
            onRefresh: acpSessionModeProbeState.onRefresh,
        },
        acpConfigOptionsProbe: {
            phase: acpConfigOptionsProbeState.phase,
            onRefresh: acpConfigOptionsProbeState.onRefresh,
        },
        machineName: destinationParts.length > 0 ? destinationParts.join(' · ') : undefined,
    });
}
