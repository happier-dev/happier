import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { Platform, View, useWindowDimensions } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { AgentInput } from '@/components/sessions/agentInput';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { PopoverPortalTargetProvider } from '@/components/ui/popover';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type { CreatedSessionFollowUpContext } from '../hooks/useCreateNewSession';
import { useNewSessionAttachmentsController } from '@/components/sessions/new/attachments/useNewSessionAttachmentsController';

// Treat <=767px as "mobile" on web: keep the AgentInput bottom-anchored like native.
const MOBILE_WEB_BOTTOM_ANCHORED_WIDTH = 768;

export type NewSessionSimplePanelProps = Readonly<{
    popoverBoundaryRef: React.RefObject<View>;
    headerHeight: number;
    safeAreaTop: number;
    safeAreaBottom: number;
    newSessionTopPadding: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    containerStyle: ViewStyle;
    sessionPrompt: string;
    setSessionPrompt: (v: string) => void;
    handleCreateSession: (opts?: Readonly<{ initialMessage?: 'send' | 'skip'; afterCreated?: (context: CreatedSessionFollowUpContext) => void | Promise<void> }>) => void;
    canCreate: boolean;
    isCreating: boolean;
    emptyAutocompletePrefixes: React.ComponentProps<typeof AgentInput>['autocompletePrefixes'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    sessionPromptInputMaxHeight: number;
    automationSection?: React.ReactNode;
    submitAccessibilityLabel?: React.ComponentProps<typeof AgentInput>['submitAccessibilityLabel'];
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
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
    profilePopover?: React.ComponentProps<typeof AgentInput>['profilePopover'];
    targetServerId?: string | null;
    attachmentFlowId?: string | null;
}>;

export function NewSessionSimplePanel(props: NewSessionSimplePanelProps): React.ReactElement {
    const { width: windowWidth } = useWindowDimensions();
    const shouldBottomAnchor =
        Platform.OS !== 'web' || windowWidth < MOBILE_WEB_BOTTOM_ANCHORED_WIDTH;

    const {
        attachmentsUploadsEnabled,
        filePickerRef,
        hasSendableAttachments,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        extraActionChips,
        handleSend,
    } = useNewSessionAttachmentsController({
        flowId: props.attachmentFlowId,
        isCreating: props.isCreating,
        sessionPrompt: props.sessionPrompt,
        handleCreateSession: props.handleCreateSession,
        selectedProfileId: props.selectedProfileId,
        targetServerId: props.targetServerId,
        baseActionChips: props.agentInputExtraActionChips,
    });

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? props.headerHeight + props.safeAreaBottom + 16 : 0}
            style={[
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
                            paddingTop: 0,
                        },
                    ]),
            ]}
        >
            <View
                ref={props.popoverBoundaryRef}
                style={{
                    flex: 1,
                    width: '100%',
                    justifyContent: shouldBottomAnchor ? 'flex-end' : 'center',
                }}
            >
                <PopoverPortalTargetProvider>
                    <PopoverBoundaryProvider boundaryRef={props.popoverBoundaryRef}>
                        <View
                            style={{
                                width: '100%',
                                alignSelf: 'center',
                                paddingTop: props.safeAreaTop + props.newSessionTopPadding,
                                ...(shouldBottomAnchor ? { marginTop: 'auto' } : {}),
                            }}
                        >
                            {/* AgentInput with inline chips - sticky at bottom */}
                            <View
                                style={{
                                    paddingBottom: props.newSessionBottomPadding,
                                }}
                            >
                                <View style={{ paddingHorizontal: props.newSessionSidePadding }}>
                                    <View style={{ width: '100%', alignSelf: 'center' }}>
                                        <AgentInput
                                            value={props.sessionPrompt}
                                            onChangeText={props.setSessionPrompt}
                                            onSend={handleSend}
                                            isSendDisabled={!props.canCreate}
                                            isSending={props.isCreating}
                                            placeholder={t('session.inputPlaceholder')}
                                            autocompletePrefixes={props.emptyAutocompletePrefixes}
                                            autocompleteSuggestions={props.emptyAutocompleteSuggestions}
                                            extraActionChips={extraActionChips}
                                            inputMaxHeight={props.sessionPromptInputMaxHeight}
                                            submitAccessibilityLabel={props.submitAccessibilityLabel}
                                            agentType={props.agentType}
                                            agentLabel={props.agentLabel}
                                            onAgentClick={props.handleAgentClick}
                                            agentPickerTitle={props.agentPickerTitle}
                                            agentPickerOptions={props.agentPickerOptions}
                                            agentPickerSelectedOptionId={props.agentPickerSelectedOptionId}
                                            onAgentPickerSelect={props.onAgentPickerSelect}
                                            agentPickerApplyLabel={props.agentPickerApplyLabel}
                                            agentPickerProbe={props.agentPickerProbe}
                                            attachments={agentInputAttachments}
                                            onAttachmentsAdded={attachmentsUploadsEnabled ? addWebFiles : undefined}
                                            hasSendableAttachments={hasSendableAttachments}
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
                                            maxWidthCap={null}
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
                                        {props.automationSection ?? null}
                                        {attachmentsUploadsEnabled ? (
                                            <AttachmentFilePicker ref={filePickerRef} onAttachmentsPicked={addPickedAttachments} multiple />
                                        ) : null}
                                    </View>
                                </View>
                            </View>
                        </View>
                    </PopoverBoundaryProvider>
                </PopoverPortalTargetProvider>
            </View>
        </KeyboardAvoidingView>
    );
}
