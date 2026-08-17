import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { Keyboard, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { AgentInput } from '@/components/sessions/agentInput';
import { projectAgentInputAttachmentRowItems } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputExtraActionPresentation } from '@/components/sessions/agentInput/agentInputContracts';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { t } from '@/text';
import type { AcpConfigOptionOverridesV1, ProviderErrorV1 } from '@happier-dev/protocol';
import type { HandleCreateSessionOptions } from '../hooks/useCreateNewSession';
import { useNewSessionAttachmentsController } from '@/components/sessions/new/attachments/useNewSessionAttachmentsController';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import {
    ComposerKeyboardScaffold,
    resolveAvailablePanelHeight,
    useComposerAvailablePanelHeight,
} from '@/components/sessions/keyboardAvoidance';
import { computeNewSessionComposerPanelMaxHeight } from '@/components/sessions/agentInput/inputMaxHeight';
import {
    NewSessionLaunchPendingPreview,
    shouldRenderNewSessionLaunchPendingPreview,
} from '@/components/sessions/new/components/NewSessionLaunchPendingPreview';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import { NewSessionProviderLaunchError } from '@/components/sessions/new/components/NewSessionProviderLaunchError';
import {
    useNewSessionPromptValue,
    type NewSessionPromptStore,
} from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { NewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';

const SIMPLE_NEW_SESSION_MIN_TOP_GAP = 8;

export type NewSessionSimplePanelProps = Readonly<{
    popoverBoundaryRef: React.RefObject<View>;
    headerHeight: number;
    safeAreaTop: number;
    safeAreaBottom: number;
    newSessionTopPadding: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    shouldBottomAnchor?: boolean;
    containerStyle: ViewStyle;
    promptStore: NewSessionPromptStore;
    composerDocument?: NewSessionComposerDocument;
    setSessionPrompt: (v: string) => void;
    handleCreateSession: (opts?: HandleCreateSessionOptions) => void;
    canCreate: boolean;
    isCreating: boolean;
    pendingLaunchAttempt?: NewSessionLaunchAttempt | null;
    providerLaunchError?: ProviderErrorV1 | null;
    retryProviderLaunch?: () => void;
    emptyAutocompleteKinds: React.ComponentProps<typeof AgentInput>['autocompleteKinds'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    sessionPromptInputMaxHeight?: number;
    submitAccessibilityLabel?: React.ComponentProps<typeof AgentInput>['submitAccessibilityLabel'];
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
    /** Removable "continue from this Session" chip and its attachment row. */
    sourceContextPresentation?: AgentInputExtraActionPresentation | null;
    agentType: React.ComponentProps<typeof AgentInput>['agentType'];
    agentLabel?: React.ComponentProps<typeof AgentInput>['agentLabel'];
    handleAgentClick: React.ComponentProps<typeof AgentInput>['onAgentClick'];
    agentPickerTitle?: React.ComponentProps<typeof AgentInput>['agentPickerTitle'];
    agentPickerOptions?: React.ComponentProps<typeof AgentInput>['agentPickerOptions'];
    agentPickerSelectedOptionId?: React.ComponentProps<typeof AgentInput>['agentPickerSelectedOptionId'];
    onAgentPickerSelect?: React.ComponentProps<typeof AgentInput>['onAgentPickerSelect'];
    agentPickerApplyLabel?: React.ComponentProps<typeof AgentInput>['agentPickerApplyLabel'];
    agentPickerProbe?: React.ComponentProps<typeof AgentInput>['agentPickerProbe'];
    permissionMode: React.ComponentProps<typeof AgentInput>['permissionMode'];
    handlePermissionModeChange: React.ComponentProps<typeof AgentInput>['onPermissionModeChange'];
    modelMode: React.ComponentProps<typeof AgentInput>['modelMode'];
    setModelMode: React.ComponentProps<typeof AgentInput>['onModelModeChange'];
    modelOptions: ReadonlyArray<{ value: string; label: string; description: string }>;
    modelOptionsProbe?: React.ComponentProps<typeof AgentInput>['modelOptionsOverrideProbe'];
    acpSessionModeOptions?: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
    acpSessionModeProbe?: React.ComponentProps<typeof AgentInput>['acpSessionModeOptionsOverrideProbe'];
    acpSessionModeId?: string | null;
    setAcpSessionModeId?: (modeId: string | null) => void;
    acpConfigOptions?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverride'];
    acpConfigOptionsProbe?: React.ComponentProps<typeof AgentInput>['acpConfigOptionsOverrideProbe'];
    acpConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    setAcpConfigOptionOverride?: (configId: string, value: string) => void;
    connectionStatus: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    statusBadges?: React.ComponentProps<typeof AgentInput>['statusBadges'];
    machineName: string | undefined;
    machinePopover?: React.ComponentProps<typeof AgentInput>['machinePopover'];
    selectedPath: string;
    pathPopover?: React.ComponentProps<typeof AgentInput>['pathPopover'];
    showResumePicker: boolean;
    resumeSessionId: string | null;
    resumePopover?: React.ComponentProps<typeof AgentInput>['resumePopover'];
    isResumeSupportChecking: boolean;
    useProfiles: boolean;
    selectedProfileId: string | null;
    selectedMachineId?: string | null;
    selectedMachineHomeDir?: string | null;
    profilePopover?: React.ComponentProps<typeof AgentInput>['profilePopover'];
    targetServerId?: string | null;
    attachmentFlowId?: string | null;
}>;

export function NewSessionSimplePanel(props: NewSessionSimplePanelProps): React.ReactElement {
    const { width: windowWidth } = useWindowDimensions();
    const shouldBottomAnchor =
        props.shouldBottomAnchor ?? (Platform.OS !== 'web' || isMobileLayoutWidth(windowWidth));
    const minimumTopGap = shouldBottomAnchor ? Math.min(props.newSessionTopPadding, SIMPLE_NEW_SESSION_MIN_TOP_GAP) : 0;
    const handleDismissKeyboard = React.useCallback(() => {
        Keyboard.dismiss();
    }, []);

    const {
        attachmentsUploadsEnabled,
        filePickerRef,
        hasSendableAttachments,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        actionChips,
        attachmentRowItems,
        handleSend,
    } = useNewSessionAttachmentsController({
        flowId: props.attachmentFlowId,
        isCreating: props.isCreating,
        promptStore: props.promptStore,
        handleCreateSession: props.handleCreateSession,
        selectedProfileId: props.selectedProfileId,
        targetServerId: props.targetServerId,
        selectedMachineId: props.selectedMachineId ?? null,
        selectedMachineHomeDir: props.selectedMachineHomeDir,
        selectedPath: props.selectedPath,
        baseActionChips: [
            ...(props.agentInputExtraActionChips ?? []),
            ...(props.composerDocument?.extraActionChips ?? []),
        ],
        sourceContextPresentation: props.sourceContextPresentation ?? null,
        composerDocument: props.composerDocument,
    });
    const projectedAttachmentRowItems = React.useMemo(() => (
        projectAgentInputAttachmentRowItems({
            items: [
                ...(props.composerDocument?.attachmentRowItems ?? []),
                ...attachmentRowItems,
            ],
            transferAttachments: agentInputAttachments,
        })
    ), [agentInputAttachments, attachmentRowItems, props.composerDocument?.attachmentRowItems]);

    const composerReservedHeight = props.newSessionBottomPadding
        + (shouldBottomAnchor ? 0 : props.safeAreaTop + props.newSessionTopPadding);
    const showPendingLaunchPreview = props.isCreating
        && shouldRenderNewSessionLaunchPendingPreview(props.pendingLaunchAttempt);
    const shellStyle = [
        props.containerStyle,
        ...(shouldBottomAnchor
            ? [
                {
                    justifyContent: 'flex-end' as const,
                    paddingTop: 0,
                },
            ]
            : [
                {
                    justifyContent: 'center' as const,
                },
            ]),
    ];
    return (
        <ComposerKeyboardScaffold
            testID="new-session-keyboard-host"
            mode="newSession"
            contentTestID="new-session-keyboard-content"
            composerTestID="new-session-composer-keyboard-host"
            headerHeight={props.headerHeight}
            safeAreaBottom={props.safeAreaBottom}
            style={shellStyle}
            contentStyle={
                shouldBottomAnchor
                    ? undefined
                    : {
                        flexBasis: 0,
                        flexGrow: 0,
                    }
            }
            composer={(
                <PopoverBoundaryProvider boundaryRef={props.popoverBoundaryRef}>
                    <View
                        style={{
                            width: '100%',
                            alignSelf: 'center',
                            ...(shouldBottomAnchor
                                ? null
                                : { paddingTop: props.safeAreaTop + props.newSessionTopPadding }),
                        }}
                    >
                        <NewSessionSimplePanelComposer
                            panelProps={props}
                            reservedHeight={composerReservedHeight}
                            attachmentsController={{
                                attachmentsUploadsEnabled,
                                filePickerRef,
                                hasSendableAttachments: hasSendableAttachments
                                    || props.composerDocument?.hasSendableAttachments === true,
                                addWebFiles,
                                addPickedAttachments,
                                actionChips,
                                attachmentRowItems: projectedAttachmentRowItems,
                                handleSend,
                            }}
                        />
                    </View>
                </PopoverBoundaryProvider>
            )}
        >
            <View
                ref={props.popoverBoundaryRef}
                style={{
                    flex: 1,
                    width: '100%',
                    justifyContent: shouldBottomAnchor ? 'flex-end' : 'center',
                }}
            >
                {shouldBottomAnchor ? (
                    <Pressable
                        accessible={false}
                        style={{ flex: 1, width: '100%', minHeight: minimumTopGap }}
                        onPress={handleDismissKeyboard}
                    />
                ) : null}
                {showPendingLaunchPreview ? (
                    <View
                        style={{
                            width: '100%',
                            alignSelf: 'stretch',
                            paddingHorizontal: props.newSessionSidePadding,
                            paddingBottom: 8,
                        }}
                    >
                        <View style={{ width: '100%', alignSelf: 'center' }}>
                            <NewSessionLaunchPendingPreview launchAttempt={props.pendingLaunchAttempt} />
                        </View>
                    </View>
                ) : null}
            </View>
        </ComposerKeyboardScaffold>
    );
}

type NewSessionSimplePanelComposerProps = Readonly<{
    panelProps: NewSessionSimplePanelProps;
    reservedHeight: number;
    attachmentsController: Readonly<{
        attachmentsUploadsEnabled: boolean;
        filePickerRef: React.ComponentPropsWithRef<typeof AttachmentFilePicker>['ref'];
        hasSendableAttachments: boolean;
        addWebFiles: NonNullable<React.ComponentProps<typeof AgentInput>['onAttachmentsAdded']>;
        addPickedAttachments: React.ComponentProps<typeof AttachmentFilePicker>['onAttachmentsPicked'];
        actionChips: React.ComponentProps<typeof AgentInput>['extraActionChips'];
        attachmentRowItems: React.ComponentProps<typeof AgentInput>['attachmentRowItems'];
        handleSend: React.ComponentProps<typeof AgentInput>['onSend'];
    }>;
}>;

function NewSessionSimplePanelComposer({
    panelProps: props,
    reservedHeight,
    attachmentsController,
}: NewSessionSimplePanelComposerProps): React.ReactElement {
    // Subscribed here, at the leaf that renders the input: a keystroke re-renders this
    // composer and nothing above it — not the panel, and not the screen model.
    const sessionPrompt = useNewSessionPromptValue(props.promptStore);
    const { height: windowHeight } = useWindowDimensions();
    const availablePanelHeight = useComposerAvailablePanelHeight();
    const initialAvailablePanelHeight = React.useMemo(() => {
        if (
            typeof windowHeight !== 'number'
            || !Number.isFinite(windowHeight)
            || windowHeight <= 0
            || !Number.isFinite(props.headerHeight)
            || props.headerHeight <= 0
        ) {
            return undefined;
        }

        return resolveAvailablePanelHeight({
            viewportHeight: windowHeight,
            headerHeight: props.headerHeight,
            keyboardHeight: 0,
            safeAreaBottom: props.safeAreaBottom,
        });
    }, [props.headerHeight, props.safeAreaBottom, windowHeight]);
    const maxPanelHeight = computeNewSessionComposerPanelMaxHeight({
        mode: 'simple',
        availablePanelHeight: availablePanelHeight ?? initialAvailablePanelHeight,
        reservedHeight,
    });

    return (
        <View
            style={{
                paddingBottom: props.newSessionBottomPadding,
            }}
        >
            <View style={{ paddingHorizontal: props.newSessionSidePadding, width: '100%', alignSelf: 'stretch' }}>
                <View style={{ width: '100%', alignSelf: 'center' }}>
                    <NewSessionProviderLaunchError
                        error={props.providerLaunchError}
                        retry={props.retryProviderLaunch}
                    />
                    <PluginContextualResourceStoreProvider>
                        {props.composerDocument?.beforeComposer}
                        <AgentInput
                        value={sessionPrompt}
                        onChangeText={props.setSessionPrompt}
                        structuredInputMentions={props.composerDocument?.structuredInputMentions}
                        onStructuredInputMentionsChange={props.composerDocument?.onStructuredInputMentionsChange}
                        onComposerFocusChange={props.composerDocument?.onComposerFocusChange}
                        onComposerFocusRequestChange={props.composerDocument?.onComposerFocusRequestChange}
                        onComposerActionBarLayoutChange={props.composerDocument?.onComposerActionBarLayoutChange}
                        composerDecorations={props.composerDocument?.composerDecorations ?? []}
                        composerInputLock={props.composerDocument?.composerInputLock ?? null}
                        onSend={attachmentsController.handleSend}
                        isSendDisabled={!props.canCreate || props.composerDocument?.composerInputLock !== null}
                        disabled={props.composerDocument?.composerInputLock?.mode === 'editAndSubmit'}
                        isSending={props.isCreating}
                        placeholder={t('session.inputPlaceholder')}
                        autocompleteKinds={props.emptyAutocompleteKinds}
                        autocompleteSuggestions={props.emptyAutocompleteSuggestions}
                        extraActionChips={attachmentsController.actionChips}
                        attachmentRowItems={attachmentsController.attachmentRowItems}
                        inputMaxHeight={props.sessionPromptInputMaxHeight}
                        maxPanelHeight={maxPanelHeight}
                        panelMaxHeightMode="host-constrained"
                        submitAccessibilityLabel={props.submitAccessibilityLabel}
                        agentType={props.agentType}
                        agentLabel={props.agentLabel}
                        onAgentClick={props.handleAgentClick}
                        agentPickerOptions={props.agentPickerOptions}
                        agentPickerSelectedOptionId={props.agentPickerSelectedOptionId}
                        onAgentPickerSelect={props.onAgentPickerSelect}
                        agentPickerApplyLabel={props.agentPickerApplyLabel}
                        agentPickerProbe={props.agentPickerProbe}
                        onAttachmentsAdded={attachmentsController.attachmentsUploadsEnabled ? attachmentsController.addWebFiles : undefined}
                        hasSendableAttachments={attachmentsController.hasSendableAttachments}
                        permissionMode={props.permissionMode}
                        onPermissionModeChange={props.handlePermissionModeChange}
                        modelMode={props.modelMode}
                        onModelModeChange={props.setModelMode}
                        modelOptionsOverride={props.modelOptions}
                        modelOptionsOverrideProbe={props.modelOptionsProbe}
                        acpSessionModeOptionsOverride={props.acpSessionModeOptions}
                        acpSessionModeSelectedIdOverride={props.acpSessionModeId ?? null}
                        acpSessionModeOptionsOverrideProbe={props.acpSessionModeProbe}
                        onAcpSessionModeChange={
                            (props.acpSessionModeOptions?.length ?? 0) > 0 && props.setAcpSessionModeId
                                ? (modeId) => props.setAcpSessionModeId?.(modeId === 'default' ? null : modeId)
                                : undefined
                        }
                        acpConfigOptionsOverride={props.acpConfigOptions}
                        acpConfigOptionsOverrideProbe={props.acpConfigOptionsProbe}
                        acpConfigOptionOverridesOverride={props.acpConfigOptionOverrides ?? null}
                        onAcpConfigOptionChange={props.setAcpConfigOptionOverride}
                        connectionStatus={props.connectionStatus}
                        statusBadges={props.statusBadges}
                        machineName={props.machineName}
                        machinePopover={props.machinePopover}
                        onMachineClick={undefined}
                        currentPath={props.selectedPath}
                        onPathClick={undefined}
                        pathPopover={props.pathPopover}
                        resumeSessionId={props.showResumePicker ? props.resumeSessionId : undefined}
                        onResumeClick={undefined}
                        resumePopover={props.showResumePicker ? props.resumePopover : undefined}
                        resumeIsChecking={props.isResumeSupportChecking}
                        contentPaddingHorizontal={0}
                        {...(props.useProfiles
                            ? {
                                profileId: props.selectedProfileId,
                                profilePopover: props.profilePopover,
                                onProfileClick: undefined,
                                envVarsCount: undefined,
                                envVarsPopover: undefined,
                                onEnvVarsClick: undefined,
                            }
                            : {})}
                        />
                        {props.composerDocument?.afterComposer}
                    </PluginContextualResourceStoreProvider>
                    {attachmentsController.attachmentsUploadsEnabled ? (
                        <AttachmentFilePicker
                            ref={attachmentsController.filePickerRef}
                            onAttachmentsPicked={attachmentsController.addPickedAttachments}
                            multiple
                        />
                    ) : null}
                </View>
            </View>
        </View>
    );
}
