import { useNewSessionWizardProps } from '@/components/sessions/new/hooks/useNewSessionWizardProps';

type NewSessionWizardParams = Parameters<typeof useNewSessionWizardProps>[0];
type ModelOptionsProbe = NonNullable<NewSessionWizardParams['modelOptionsProbe']>;
type AcpSessionModeProbe = NonNullable<NewSessionWizardParams['acpSessionModeProbe']>;
type AcpConfigOptionsProbe = NonNullable<NewSessionWizardParams['acpConfigOptionsProbe']>;

type ModelOptionsProbeState = ModelOptionsProbe;

type AcpSessionModeProbeState = Readonly<{
    phase: AcpSessionModeProbe['phase'];
    onRefresh: AcpSessionModeProbe['onRefresh'];
}>;

type AcpConfigOptionsProbeState = Readonly<{
    phase: AcpConfigOptionsProbe['phase'];
    onRefresh: AcpConfigOptionsProbe['onRefresh'];
}>;

export function useNewSessionScreenWizardProps(params: Readonly<{
    layout: Pick<
        NewSessionWizardParams,
        | 'theme'
        | 'styles'
        | 'safeAreaTop'
        | 'safeAreaBottom'
        | 'headerHeight'
        | 'newSessionTopPadding'
        | 'newSessionSidePadding'
        | 'newSessionBottomPadding'
        | 'shouldBottomAnchor'
    >;
    sectionPresentation?: NewSessionWizardParams['sectionPresentation'];
    useColumnLayout?: NewSessionWizardParams['useColumnLayout'];
    profiles: Pick<
        NewSessionWizardParams,
        | 'useProfiles'
        | 'profiles'
        | 'favoriteProfileIds'
        | 'setFavoriteProfileIds'
        | 'selectedProfileId'
        | 'onPressDefaultEnvironment'
        | 'onPressProfile'
        | 'selectedMachineId'
        | 'getProfileDisabled'
        | 'getProfileSubtitleExtra'
        | 'handleAddProfile'
        | 'openProfileEdit'
        | 'handleDuplicateProfile'
        | 'handleDeleteProfile'
        | 'suppressNextSecretAutoPromptKeyRef'
        | 'openSecretRequirementModal'
        | 'profilesGroupTitles'
    >;
    profileSecrets: Pick<
        NewSessionWizardParams,
        | 'machineEnvPresence'
        | 'secrets'
        | 'secretBindingsByProfileId'
        | 'selectedSecretIdByProfileIdByEnvVarName'
        | 'sessionOnlySecretValueByProfileIdByEnvVarName'
    >;
    installables: Pick<NewSessionWizardParams, 'wizardInstallableDeps' | 'selectedMachineCapabilities'>;
    agent: Pick<
        NewSessionWizardParams,
        | 'cliAvailability'
        | 'tmuxRequested'
        | 'enabledAgentIds'
        | 'isAgentSelectable'
        | 'agentType'
        | 'agentLabel'
        | 'setAgentType'
        | 'agentPickerOptions'
        | 'onAgentPickerSelect'
        | 'selectedBackendEntry'
        | 'modelOptions'
        | 'favoriteModelSelections'
        | 'setFavoriteModelSelections'
        | 'acpSessionModeOptions'
        | 'acpSessionModeId'
        | 'setAcpSessionModeId'
        | 'acpConfigOptions'
        | 'acpConfigOptionOverrides'
        | 'setAcpConfigOptionOverride'
        | 'modelMode'
        | 'modelSelection'
        | 'setModelMode'
        | 'setModelSelection'
        | 'teamCredentialResources'
        | 'teamNameById'
        | 'homeNameByTeamId'
        | 'currentTeamCredentialResourceKeys'
        | 'selectedTeamCredentialModel'
        | 'onSelectTeamCredentialModel'
        | 'providerModelGroups'
        | 'providerModelProjectionAuthoritative'
        | 'providerModelProjectionError'
        | 'providerModelProjectionFailures'
        | 'retryProviderModelProjection'
        | 'providerCurrentSelectionRecovery'
        | 'hiddenNativeModelKeys'
        | 'experimentalModelConfirmation'
        | 'selectedIndicatorColor'
        | 'profileMap'
        | 'permissionMode'
        | 'handlePermissionModeChange'
    > & Readonly<{
        selectedBackendTargetKey: string;
        selectedBackendEntryTargetKey?: string;
        agentPickerSelectedOptionId?: string | null;
        modelOptionsProbeState: ModelOptionsProbeState;
        acpSessionModeProbeState: AcpSessionModeProbeState;
        acpConfigOptionsProbeState: AcpConfigOptionsProbeState;
    }>;
    machine: Pick<
        NewSessionWizardParams,
        | 'machines'
        | 'machineGroups'
        | 'machinePoolGroups'
        | 'temporaryComputerProjection'
        | 'targetServerId'
        | 'selectedMachine'
        | 'recentMachines'
        | 'favoriteMachineItems'
        | 'useMachinePickerSearch'
        | 'refreshMachineData'
        | 'setSelectedMachineId'
        | 'getBestPathForMachine'
        | 'setSelectedPath'
        | 'setDraftSelectedPath'
        | 'favoriteMachines'
        | 'setFavoriteMachines'
        | 'selectedPath'
        | 'recentPaths'
        | 'usePathPickerSearch'
        | 'favoriteDirectories'
        | 'setFavoriteDirectories'
    >;
    footer: Pick<
        NewSessionWizardParams,
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
        | 'connectionStatus'
        | 'machinePopover'
        | 'pathPopover'
        | 'folderChipState'
        | 'onRemoveFolder'
        | 'resumeSessionId'
        | 'resumePopover'
        | 'isResumeSupportChecking'
        | 'sessionPromptInputMaxHeight'
        | 'agentInputExtraActionChips'
        | 'sourceContextPresentation'
        | 'attachmentFlowId'
        | 'statusBadges'
        | 'composerTopContent'
        | 'statusTrailingActions'
    >;
}>): ReturnType<typeof useNewSessionWizardProps> {
    const {
        selectedBackendTargetKey,
        selectedBackendEntryTargetKey,
        agentPickerSelectedOptionId,
        modelOptionsProbeState,
        acpSessionModeProbeState,
        acpConfigOptionsProbeState,
        ...agentProps
    } = params.agent;

    return useNewSessionWizardProps({
        ...params.layout,
        ...params.profiles,
        ...params.profileSecrets,
        ...params.installables,
        sectionPresentation: params.sectionPresentation,
        useColumnLayout: params.useColumnLayout,
        ...agentProps,
        ...params.machine,
        ...params.footer,
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
    });
}
