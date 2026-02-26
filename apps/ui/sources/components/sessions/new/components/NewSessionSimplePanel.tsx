import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { Platform, Pressable, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SessionTypeSelectorRows } from '@/components/ui/forms/SessionTypeSelector';
import { AgentInput } from '@/components/sessions/agentInput';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { Ionicons } from '@expo/vector-icons';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { PopoverPortalTargetProvider } from '@/components/ui/popover';
import { t } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { formatAttachmentsBlock, uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { sync } from '@/sync/sync';
import { Text } from '@/components/ui/text/Text';


export function NewSessionSimplePanel(props: Readonly<{
    popoverBoundaryRef: React.RefObject<View>;
    headerHeight: number;
    safeAreaTop: number;
    safeAreaBottom: number;
    newSessionTopPadding: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    containerStyle: ViewStyle;
    showSessionTypeSelector: boolean;
    sessionType: 'simple' | 'worktree';
    setSessionType: (t: 'simple' | 'worktree') => void;
    sessionPrompt: string;
    setSessionPrompt: (v: string) => void;
    handleCreateSession: (opts?: Readonly<{ initialMessage?: 'send' | 'skip'; afterCreated?: (sessionId: string) => void | Promise<void> }>) => void;
    canCreate: boolean;
    isCreating: boolean;
    emptyAutocompletePrefixes: React.ComponentProps<typeof AgentInput>['autocompletePrefixes'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    sessionPromptInputMaxHeight: number;
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
    agentType: React.ComponentProps<typeof AgentInput>['agentType'];
    handleAgentClick: React.ComponentProps<typeof AgentInput>['onAgentClick'];
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
    connectionStatus: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    machineName: string | undefined;
    handleMachineClick: React.ComponentProps<typeof AgentInput>['onMachineClick'];
    selectedPath: string;
    handlePathClick: React.ComponentProps<typeof AgentInput>['onPathClick'];
    showResumePicker: boolean;
    resumeSessionId: string | null;
    handleResumeClick: React.ComponentProps<typeof AgentInput>['onResumeClick'];
    isResumeSupportChecking: boolean;
    useProfiles: boolean;
    selectedProfileId: string | null;
    handleProfileClick: React.ComponentProps<typeof AgentInput>['onProfileClick'];
    selectedProfileEnvVarsCount: number;
    handleEnvVarsClick: () => void;
}>): React.ReactElement {
    const attachmentsUploadsEnabled = useFeatureEnabled('attachments.uploads');
    const attachmentsUploadConfig = useAttachmentsUploadConfig();
    const attachmentDraftManager = useAttachmentDraftManager({
        enabled: attachmentsUploadsEnabled,
        maxFileBytes: attachmentsUploadConfig.maxFileBytes,
    });
    const {
        filePickerRef,
        drafts,
        hasSendableAttachments,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        applyDraftPatch,
        clearDrafts,
    } = attachmentDraftManager;

    const extraActionChips = React.useMemo(() => {
        const base = props.agentInputExtraActionChips ?? [];
        if (!attachmentsUploadsEnabled) return base;
        return [
            {
                key: 'attachments-add',
                render: ({ chipStyle, iconColor, showLabel, textStyle }: any) => (
                    <Pressable
                        onPress={() => filePickerRef.current?.open()}
                        disabled={props.isCreating}
                        style={({ pressed }) => chipStyle(Boolean(pressed))}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Ionicons name="attach-outline" size={16} color={iconColor} />
                            {showLabel ? <Text style={textStyle}>Attach</Text> : null}
                        </View>
                    </Pressable>
                ),
            },
            ...base,
        ] as any;
    }, [attachmentsUploadsEnabled, filePickerRef, props.agentInputExtraActionChips, props.isCreating]);

    const handleSend = React.useCallback(() => {
        if (!attachmentsUploadsEnabled || drafts.length === 0) {
            props.handleCreateSession();
            return;
        }

        const initialPrompt = String(props.sessionPrompt ?? '');
        props.handleCreateSession({
            initialMessage: 'skip',
            afterCreated: async (sessionId) => {
                const { uploaded } = await uploadAttachmentDraftsToSession({
                    sessionId,
                    drafts,
                    config: attachmentsUploadConfig,
                    applyDraftPatch,
                });
                const attachmentsBlock = formatAttachmentsBlock(uploaded);
                const trimmed = initialPrompt.trim();
                const text = trimmed.length > 0 ? `${trimmed}\n\n${attachmentsBlock}` : attachmentsBlock;
                await sync.sendMessage(sessionId, text);
                clearDrafts();
            },
        });
    }, [
        applyDraftPatch,
        attachmentsUploadConfig,
        attachmentsUploadsEnabled,
        clearDrafts,
        drafts,
        props,
    ]);

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? props.headerHeight + props.safeAreaBottom + 16 : 0}
            style={[
                props.containerStyle,
                ...(Platform.OS === 'web'
                    ? [
                        {
                            justifyContent: 'center' as const,
                            paddingTop: 0,
                        },
                    ]
                    : [
                        {
                            justifyContent: 'flex-end' as const,
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
                    // Keep the content centered on web. Without this, the boundary wrapper (flex:1)
                    // can cause the inner content to stick to the top even when the modal is centered.
                    justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
                }}
            >
                <PopoverPortalTargetProvider>
                    <PopoverBoundaryProvider boundaryRef={props.popoverBoundaryRef}>
                        <View
                            style={{
                                width: '100%',
                                alignSelf: 'center',
                                paddingTop: props.safeAreaTop + props.newSessionTopPadding,
                                ...(Platform.OS !== 'web' ? { marginTop: 'auto' } : {}),
                            }}
                        >
                            {/* Session type selector only if enabled via experiments */}
                            {props.showSessionTypeSelector && (
                                <View style={{ paddingHorizontal: props.newSessionSidePadding, marginBottom: 16 }}>
                                    <View style={{ width: '100%', alignSelf: 'center' }}>
                                        <ItemGroup title={t('newSession.sessionType.title')} containerStyle={{ marginHorizontal: 0 }}>
                                            <SessionTypeSelectorRows value={props.sessionType} onChange={props.setSessionType} />
                                        </ItemGroup>
                                    </View>
                                </View>
                            )}

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
                                            agentType={props.agentType}
                                            onAgentClick={props.handleAgentClick}
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
                                            connectionStatus={props.connectionStatus}
                                            machineName={props.machineName}
                                            onMachineClick={props.handleMachineClick}
                                            currentPath={props.selectedPath}
                                            onPathClick={props.handlePathClick}
                                            resumeSessionId={props.showResumePicker ? props.resumeSessionId : undefined}
                                            onResumeClick={props.showResumePicker ? props.handleResumeClick : undefined}
                                            resumeIsChecking={props.isResumeSupportChecking}
                                            contentPaddingHorizontal={0}
                                            maxWidthCap={null}
                                            {...(props.useProfiles
                                                ? {
                                                    profileId: props.selectedProfileId,
                                                    onProfileClick: props.handleProfileClick,
                                                    envVarsCount: props.selectedProfileEnvVarsCount || undefined,
                                                    onEnvVarsClick: props.selectedProfileEnvVarsCount > 0 ? props.handleEnvVarsClick : undefined,
                                                }
                                                : {})}
                                        />
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
