import * as React from 'react';

import type {
    AgentInputContentPopoverConfig,
    AgentInputContentPopoverRenderArgs,
} from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import type { NewSessionSimplePanelProps } from '../components/NewSessionSimplePanel';

const objectSignatureIds = new WeakMap<object, number>();
let nextObjectSignatureId = 1;

function getObjectSignature(value: object | null | undefined): string {
    if (!value) return '';
    const existing = objectSignatureIds.get(value);
    if (existing !== undefined) return String(existing);
    const next = nextObjectSignatureId;
    nextObjectSignatureId += 1;
    objectSignatureIds.set(value, next);
    return String(next);
}

function stableJsonSignature(value: unknown): string {
    try {
        return JSON.stringify(value) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

function buildContentPopoverStaticSignature(config: AgentInputContentPopoverConfig | undefined): string {
    if (!config) return 'undefined';
    return stableJsonSignature({
        boundaryRef: getObjectSignature(config.boundaryRef ?? null),
        maxHeightCap: config.maxHeightCap ?? null,
        maxWidthCap: config.maxWidthCap ?? null,
        scrollEnabled: config.scrollEnabled ?? null,
        keyboardShouldPersistTaps: config.keyboardShouldPersistTaps ?? null,
        edgeFades: config.edgeFades ?? null,
        edgeIndicators: config.edgeIndicators ?? null,
        initialVisibility: config.initialVisibility ?? null,
    });
}

function useLatestRef<Value>(value: Value): React.MutableRefObject<Value> {
    const ref = React.useRef(value);
    ref.current = value;
    return ref;
}

function useStableContentPopoverConfig(
    config: AgentInputContentPopoverConfig | undefined,
): AgentInputContentPopoverConfig | undefined {
    const configRef = useLatestRef(config);
    const renderContentRef = useLatestRef(config?.renderContent);
    const signature = React.useMemo(
        () => buildContentPopoverStaticSignature(config),
        [
            config?.boundaryRef,
            config?.edgeFades,
            config?.edgeIndicators,
            config?.initialVisibility,
            config?.keyboardShouldPersistTaps,
            config?.maxHeightCap,
            config?.maxWidthCap,
            config?.scrollEnabled,
        ],
    );

    return React.useMemo(() => {
        const currentConfig = configRef.current;
        if (!currentConfig) return undefined;
        return {
            boundaryRef: currentConfig.boundaryRef,
            maxHeightCap: currentConfig.maxHeightCap,
            maxWidthCap: currentConfig.maxWidthCap,
            scrollEnabled: currentConfig.scrollEnabled,
            keyboardShouldPersistTaps: currentConfig.keyboardShouldPersistTaps,
            edgeFades: currentConfig.edgeFades,
            edgeIndicators: currentConfig.edgeIndicators,
            initialVisibility: currentConfig.initialVisibility,
            renderContent: (args: AgentInputContentPopoverRenderArgs) => {
                const renderContent = renderContentRef.current;
                return typeof renderContent === 'function' ? renderContent(args) : renderContent;
            },
        };
    }, [configRef, renderContentRef, signature]);
}

export function useNewSessionSimplePanelProps(
    params: NewSessionSimplePanelProps,
): NewSessionSimplePanelProps {
    const machinePopover = useStableContentPopoverConfig(params.machinePopover);
    const resumePopover = useStableContentPopoverConfig(params.resumePopover);
    const profilePopover = useStableContentPopoverConfig(params.profilePopover);
    const pathPopover = useStableContentPopoverConfig(params.pathPopover);

    return React.useMemo(() => ({
        popoverBoundaryRef: params.popoverBoundaryRef,
        headerHeight: params.headerHeight,
        safeAreaTop: params.safeAreaTop,
        safeAreaBottom: params.safeAreaBottom,
        newSessionTopPadding: params.newSessionTopPadding,
        newSessionSidePadding: params.newSessionSidePadding,
        newSessionBottomPadding: params.newSessionBottomPadding,
        shouldBottomAnchor: params.shouldBottomAnchor,
        containerStyle: params.containerStyle,
        promptStore: params.promptStore,
        composerDocument: params.composerDocument,
        setSessionPrompt: params.setSessionPrompt,
        handleCreateSession: params.handleCreateSession,
        canCreate: params.canCreate,
        isCreating: params.isCreating,
        pendingLaunchAttempt: params.pendingLaunchAttempt,
        providerLaunchError: params.providerLaunchError,
        retryProviderLaunch: params.retryProviderLaunch,
        emptyAutocompleteKinds: params.emptyAutocompleteKinds,
        emptyAutocompleteSuggestions: params.emptyAutocompleteSuggestions,
        sessionPromptInputMaxHeight: params.sessionPromptInputMaxHeight,
        submitAccessibilityLabel: params.submitAccessibilityLabel,
        agentInputExtraActionChips: params.agentInputExtraActionChips,
        sourceContextPresentation: params.sourceContextPresentation,
        agentType: params.agentType,
        agentLabel: params.agentLabel,
        handleAgentClick: params.handleAgentClick,
        agentPickerTitle: params.agentPickerTitle,
        agentPickerOptions: params.agentPickerOptions,
        agentPickerSelectedOptionId: params.agentPickerSelectedOptionId,
        onAgentPickerSelect: params.onAgentPickerSelect,
        agentPickerApplyLabel: params.agentPickerApplyLabel,
        agentPickerProbe: params.agentPickerProbe,
        permissionMode: params.permissionMode,
        handlePermissionModeChange: params.handlePermissionModeChange,
        modelMode: params.modelMode,
        setModelMode: params.setModelMode,
        modelOptions: params.modelOptions,
        modelOptionsProbe: params.modelOptionsProbe,
        acpSessionModeOptions: params.acpSessionModeOptions,
        acpSessionModeProbe: params.acpSessionModeProbe,
        acpSessionModeId: params.acpSessionModeId,
        setAcpSessionModeId: params.setAcpSessionModeId,
        acpConfigOptions: params.acpConfigOptions,
        acpConfigOptionsProbe: params.acpConfigOptionsProbe,
        acpConfigOptionOverrides: params.acpConfigOptionOverrides,
        setAcpConfigOptionOverride: params.setAcpConfigOptionOverride,
        connectionStatus: params.connectionStatus,
        statusBadges: params.statusBadges,
        machineName: params.machineName,
        machinePopover,
        selectedPath: params.selectedPath,
        showResumePicker: params.showResumePicker,
        resumeSessionId: params.resumeSessionId,
        resumePopover,
        isResumeSupportChecking: params.isResumeSupportChecking,
        useProfiles: params.useProfiles,
        selectedProfileId: params.selectedProfileId,
        selectedMachineId: params.selectedMachineId,
        selectedMachineHomeDir: params.selectedMachineHomeDir,
        profilePopover,
        pathPopover,
        targetServerId: params.targetServerId,
        attachmentFlowId: params.attachmentFlowId,
    }), [
        params.acpConfigOptionOverrides,
        params.acpConfigOptions,
        params.acpConfigOptionsProbe,
        params.acpSessionModeId,
        params.acpSessionModeOptions,
        params.acpSessionModeProbe,
        params.agentInputExtraActionChips,
        params.sourceContextPresentation,
        params.agentLabel,
        params.agentPickerApplyLabel,
        params.agentPickerProbe,
        params.agentPickerOptions,
        params.agentPickerSelectedOptionId,
        params.agentPickerTitle,
        params.agentType,
        params.canCreate,
        params.connectionStatus,
        params.containerStyle,
        params.emptyAutocompleteKinds,
        params.emptyAutocompleteSuggestions,
        params.handleAgentClick,
        params.handleCreateSession,
        params.handlePermissionModeChange,
        params.headerHeight,
        params.isCreating,
        params.isResumeSupportChecking,
        params.machineName,
        machinePopover,
        params.modelMode,
        params.modelOptions,
        params.modelOptionsProbe,
        params.newSessionBottomPadding,
        params.newSessionSidePadding,
        params.newSessionTopPadding,
        params.onAgentPickerSelect,
        params.permissionMode,
        params.pendingLaunchAttempt,
        params.popoverBoundaryRef,
        params.providerLaunchError,
        profilePopover,
        pathPopover,
        resumePopover,
        params.resumeSessionId,
        params.retryProviderLaunch,
        params.safeAreaBottom,
        params.safeAreaTop,
        params.selectedPath,
        params.selectedProfileId,
        params.selectedMachineId,
        params.selectedMachineHomeDir,
        params.shouldBottomAnchor,
        params.composerDocument,
        params.promptStore,
        params.sessionPromptInputMaxHeight,
        params.setAcpConfigOptionOverride,
        params.setAcpSessionModeId,
        params.setModelMode,
        params.setSessionPrompt,
        params.showResumePicker,
        params.statusBadges,
        params.submitAccessibilityLabel,
        params.targetServerId,
        params.attachmentFlowId,
        params.useProfiles,
    ]);
}
