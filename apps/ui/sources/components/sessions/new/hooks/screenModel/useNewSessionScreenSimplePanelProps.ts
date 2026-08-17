import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { useNewSessionSimplePanelProps } from '@/components/sessions/new/hooks/useNewSessionSimplePanelProps';

type ModelOptionsProbe = NonNullable<NewSessionSimplePanelProps['modelOptionsProbe']>;
type AcpSessionModeProbe = NonNullable<NewSessionSimplePanelProps['acpSessionModeProbe']>;
type AcpConfigOptionsProbe = NonNullable<NewSessionSimplePanelProps['acpConfigOptionsProbe']>;

type ModelOptionsProbeState = Readonly<{
    phase: ModelOptionsProbe['phase'];
    onRefresh: ModelOptionsProbe['onRefresh'];
}>;

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
        | 'setSessionPrompt'
        | 'handleCreateSession'
        | 'canCreate'
        | 'isCreating'
        | 'pendingLaunchAttempt'
        | 'providerLaunchError'
        | 'retryProviderLaunch'
        | 'submitAccessibilityLabel'
        | 'emptyAutocompleteKinds'
        | 'emptyAutocompleteSuggestions'
        | 'sessionPromptInputMaxHeight'
        | 'statusBadges'
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
    > & Readonly<{
        selectedBackendTargetKey: string;
        selectedBackendEntryTargetKey?: string;
        agentPickerSelectedOptionId?: string | null;
    }>;
    model: Pick<
        NewSessionSimplePanelProps,
        'permissionMode' | 'handlePermissionModeChange' | 'modelMode' | 'setModelMode' | 'modelOptions'
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
        | 'showResumePicker'
        | 'resumeSessionId'
        | 'resumePopover'
        | 'isResumeSupportChecking'
    > & Readonly<{
        machineDisplayName?: string;
        machineHost?: string;
    }>;
    profile: Pick<NewSessionSimplePanelProps, 'useProfiles' | 'selectedProfileId' | 'selectedMachineId' | 'profilePopover'>;
    targetServerId: NewSessionSimplePanelProps['targetServerId'];
    attachmentFlowId: NewSessionSimplePanelProps['attachmentFlowId'];
}>): NewSessionSimplePanelProps {
    const { selectedBackendEntryTargetKey, selectedBackendTargetKey, agentPickerSelectedOptionId, ...agentProps } = params.agent;
    const { modelOptionsProbeState, ...modelProps } = params.model;
    const { acpSessionModeProbeState, acpConfigOptionsProbeState, ...acpProps } = params.acp;
    const { machineDisplayName, machineHost, ...machineAndResumeProps } = params.machineAndResume;

    return useNewSessionSimplePanelProps({
        ...params.layout,
        ...params.creation,
        ...agentProps,
        ...modelProps,
        ...acpProps,
        ...machineAndResumeProps,
        ...params.profile,
        targetServerId: params.targetServerId,
        attachmentFlowId: params.attachmentFlowId,
        agentPickerSelectedOptionId: agentPickerSelectedOptionId ?? selectedBackendEntryTargetKey ?? selectedBackendTargetKey,
        modelOptionsProbe: {
            phase: modelOptionsProbeState.phase,
            onRefresh: modelOptionsProbeState.onRefresh,
        },
        acpSessionModeProbe: {
            phase: acpSessionModeProbeState.phase,
            onRefresh: acpSessionModeProbeState.onRefresh,
        },
        acpConfigOptionsProbe: {
            phase: acpConfigOptionsProbeState.phase,
            onRefresh: acpConfigOptionsProbeState.onRefresh,
        },
        machineName: machineDisplayName || machineHost,
    });
}
