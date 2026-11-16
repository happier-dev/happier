import { readManagedMachineSelectionName } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { useNewSessionSimplePanelProps } from '@/components/sessions/new/hooks/useNewSessionSimplePanelProps';
import type { MachinePoolSelectionOriginV1} from '@happier-dev/protocol/machines/pools/v1';
import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { describeExecutionTargetDestination } from '@/components/sessions/new/hooks/temporaryComputerTargetPresentation';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedSessionPlacementV1, ResolvedManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';
import { t } from '@/text';
import { describeInheritedDefaultSource } from '@/components/settings/teams/defaults/inheritedDefaultSourceLabel';

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
    failed?: boolean;
    refreshErrorMessage?: string;
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
        | 'newSessionAfterSendMode'
        | 'registerTemporaryComputerReplacementLaunch'
        | 'canCreate'
        | 'isCreating'
        | 'pendingLaunchAttempt'
        | 'launchPendingPreviewVisible'
        | 'providerLaunchError'
        | 'retryProviderLaunch'
        | 'launchApproval'
        | 'submitAccessibilityLabel'
        | 'emptyAutocompleteKinds'
        | 'emptyAutocompleteSuggestions'
        | 'sessionPromptInputMaxHeight'
        | 'statusBadges'
        | 'composerTopContent'
        | 'composerBottomContent'
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
        'permissionMode' | 'nativeSandbox' | 'permissionModeLock' | 'permissionModeSource' | 'handlePermissionModeChange' | 'modelMode' | 'setModelMode' | 'modelOptions' | 'modelPickerProps' | 'modelPickerPresentation'
    > & Readonly<{
        modelOptionsProbeState: ModelOptionsProbeState;
    }>;
    acp: Pick<
        NewSessionSimplePanelProps,
        | 'acpSessionModeOptions'
        | 'acpSessionModeId'
        | 'setAcpSessionModeId'
        | 'acpConfigOptions'
        | 'acpModelConfigOptionId'
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
        selectedMachine: Pick<MachineDisplayRenderable, 'id' | 'metadata' | 'availability'> | null;
        /**
         * Whether the Home has a machine (the getting-started owner's fact; `null` while unknown). With none
         * yet the machine chip asks where to run, and the folder chip waits for a machine (58d AF1).
         */
        hasMachine?: boolean | null;
        /**
         * The draft's committed target. A Temporary computer has no Machine to
         * name, so the composer chip must read it from here or keep telling the
         * author to "Select machine" for a destination they already chose.
         */
        executionTarget?: SessionAuthoringExecutionTargetV2 | null;
        managedMachineSelection?: ManagedMachineSelectionDraft | null;
        managedPlacementPreset?: Extract<ManagedSessionPlacementV1, { kind: 'preset' }> | null;
        /** The managed layer that placed the preset; a Team or Group default says so in the chip. */
        managedPlacementSource?: ResolvedManagedSessionDefaults['placement']['source'] | null;
        /** The placed preset's name once its record is read; the chip says "New machine" until then. */
        managedPlacementPresetName?: string | null;
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
        selectedMachine,
        destination,
        executionTarget,
        managedMachineSelection,
        managedPlacementPreset,
        managedPlacementSource,
        managedPlacementPresetName,
        hasMachine,
        pathPopover,
        ...machineAndResumeProps
    } = params.machineAndResume;
    // A chosen destination (a machine being created, a Temporary computer) is named even before it exists.
    const noMachineYet = hasMachine === false && !executionTarget && !selectedMachine && !managedMachineSelection && !managedPlacementPreset;
    const temporaryComputerName = describeExecutionTargetDestination(executionTarget);
    const machineName = temporaryComputerName ?? getMachineDisplayName(selectedMachine) ?? readManagedMachineSelectionName(managedMachineSelection)
        ?? (managedPlacementPreset ? managedPlacementPresetName || t('managedMachines.picker.newMachine') : undefined);
    const destinationParts = machineName ? [machineName] : [];
    // A preset the member did not pick says which default placed it; picking anything else replaces both parts.
    const placementSourceLabel = managedPlacementPreset ? describeInheritedDefaultSource(managedPlacementSource) : null;
    if (placementSourceLabel) destinationParts.unshift(placementSourceLabel);
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
            ...acpConfigOptionsProbeState,
            phase: acpConfigOptionsProbeState.phase,
            onRefresh: acpConfigOptionsProbeState.onRefresh,
        },
        // `null` is the chip's "no machine yet" state: it reads "Run on…" and opens the one picker.
        machineName: noMachineYet ? null : destinationParts.length > 0 ? destinationParts.join(' · ') : undefined,
        // A folder belongs to a machine: with none yet there is nothing to choose, so its chip waits.
        pathPopover: noMachineYet ? undefined : pathPopover,
    });
}
