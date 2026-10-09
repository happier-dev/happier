import * as React from 'react';
import { resolveRequestedSessionModeId } from '@happier-dev/protocol/actions/sessionModeIds';
import { View, useWindowDimensions } from 'react-native';

import { AgentInput } from '@/components/sessions/agentInput';
import { projectAgentInputAttachmentRowItems } from '@/components/sessions/agentInput/agentInputContracts';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { t } from '@/text';
import { useNewSessionAttachmentsController } from '@/components/sessions/new/attachments/useNewSessionAttachmentsController';
import {
    resolveAvailablePanelHeight,
    useComposerAvailablePanelHeight,
} from '@/components/sessions/keyboardAvoidance';
import { computeNewSessionComposerPanelMaxHeight } from '@/components/sessions/agentInput/inputMaxHeight';
import { NewSessionProviderLaunchError } from '@/components/sessions/new/components/NewSessionProviderLaunchError';
import { useNewSessionPromptValue } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { useNewSessionWorkflowStart } from '../hooks/useNewSessionWorkflowStart';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';

/** Home's one-row bar (lab I1): where, what with, how much latitude, and everything else behind +. */
const EMBEDDED_BAR_CONTROL_IDS = ['machine', 'path', 'engine', 'permission', 'actionMenu'] as const;
const EMBEDDED_PHONE_BAR_CONTROL_IDS = ['machine', 'engine', 'actionMenu'] as const;

/**
 * The New Session composer card: the real `AgentInput` in new-session mode with its attachments,
 * Send and launch error. The `/new` panel seats it in its keyboard scaffold (`layout="screen"`);
 * Home places it in its page column (`layout="embedded"`), where the column supplies the edges.
 */
export function NewSessionComposerCard(input: Readonly<{
    panelProps: NewSessionSimplePanelProps;
    layout: 'screen' | 'embedded';
    /** Height the host keeps around the card (screen layout); drives the panel's max height. */
    reservedHeight?: number;
    /** `false` removes the attachment affordance (a host's creation profile). Default `true`. */
    attachments?: boolean;
    /** `none` mounts no voice affordance (an embedded presentation). Default `auto`. */
    voiceAffordance?: 'auto' | 'none';
    /** The host already resolved whether this card floats or sits in the working sheet. */
    surfaceGroup?: GlassSurfaceGroup;
}>): React.ReactElement {
    const props = input.panelProps;
    const embedded = input.layout === 'embedded';
    const reservedHeight = input.reservedHeight ?? 0;
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
        attachmentsAllowed: input.attachments !== false,
        flowId: props.attachmentFlowId,
        isCreating: props.isCreating,
        promptStore: props.promptStore,
        handleCreateSession: props.handleCreateSession,
        selectedProfileId: props.selectedProfileId,
        targetServerId: props.targetServerId,
        selectedMachineId: props.selectedMachineId ?? null,
        isTemporaryComputer: props.isTemporaryComputer,
        selectedMachineHomeDir: props.selectedMachineHomeDir,
        selectedPath: props.selectedPath,
        baseActionChips: [
            ...(props.agentInputExtraActionChips ?? []),
            ...(props.composerDocument?.extraActionChips ?? []),
        ],
        sourceContextPresentation: props.sourceContextPresentation ?? null,
        composerDocument: props.composerDocument,
    });
    // A Temporary-computer replacement is a fresh submission, so it runs the
    // same Send this card already owns rather than restarting the controller.
    const registerReplacementLaunch = props.registerTemporaryComputerReplacementLaunch;
    React.useEffect(() => registerReplacementLaunch?.(handleSend), [handleSend, registerReplacementLaunch]);
    const projectedAttachmentRowItems = React.useMemo(() => (
        projectAgentInputAttachmentRowItems({
            items: [
                ...(props.composerDocument?.attachmentRowItems ?? []),
                ...attachmentRowItems,
            ],
            transferAttachments: agentInputAttachments,
        })
    ), [agentInputAttachments, attachmentRowItems, props.composerDocument?.attachmentRowItems]);

    const composerHasSendableAttachments = hasSendableAttachments
        || props.composerDocument?.hasSendableAttachments === true;

    // Subscribed here, at the leaf that renders the input: a keystroke re-renders this
    // composer and nothing above it — not the panel, and not the screen model.
    const sessionPrompt = useNewSessionPromptValue(props.promptStore);
    const workflowStart = useNewSessionWorkflowStart({ panelProps: props, prompt: sessionPrompt, surfaceGroup: input.surfaceGroup });
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    const embeddedBarControlIds = isMobileLayoutWidth(windowWidth)
        ? EMBEDDED_PHONE_BAR_CONTROL_IDS : EMBEDDED_BAR_CONTROL_IDS;
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
        reservedHeight: reservedHeight,
    });

    return (
        <View
            style={{
                paddingBottom: embedded ? 0 : props.newSessionBottomPadding,
            }}
        >
            <View style={{ paddingHorizontal: embedded ? 0 : props.newSessionSidePadding, width: '100%', alignSelf: 'stretch' }}>
                <View style={{ width: '100%', alignSelf: 'center' }}>
                    <NewSessionProviderLaunchError
                        error={props.providerLaunchError}
                        retry={props.retryProviderLaunch}
                    />
                    <PluginContextualResourceStoreProvider>
                        {props.composerDocument?.beforeComposer}
                        {props.composerTopContent}
                        {workflowStart.composer ?? <AgentInput
                        surfaceGroup={input.surfaceGroup}
                        value={sessionPrompt}
                        onChangeText={props.setSessionPrompt}
                        structuredInputMentions={props.composerDocument?.structuredInputMentions}
                        onStructuredInputMentionsChange={props.composerDocument?.onStructuredInputMentionsChange}
                        onComposerFocusChange={props.composerDocument?.onComposerFocusChange}
                        onComposerFocusRequestChange={props.composerDocument?.onComposerFocusRequestChange}
                        onPromptPickerOpenRequestChange={props.composerDocument?.onPromptPickerOpenRequestChange}
                        composerRef={props.composerDocument?.ref}
                        composerReferenceHost={props.composerReferenceHost}
                        composerFileScope={props.composerFileScope}
                        onComposerInputFlushRequestChange={props.composerDocument?.onComposerInputFlushRequestChange}
                        onComposerActionBarLayoutChange={props.composerDocument?.onComposerActionBarLayoutChange}
                        inputPersistence={props.composerDocument?.inputPersistence}
                        composerDecorations={props.composerDocument?.composerDecorations ?? []}
                        composerInputLock={props.composerDocument?.composerInputLock ?? null}
                        onSend={handleSend}
                        {...(input.voiceAffordance === 'none' ? { voiceAffordance: 'none' as const } : {})}
                        isSendDisabled={!props.canCreate || props.composerDocument?.composerInputLock !== null}
                        disabled={props.composerDocument?.composerInputLock?.mode === 'editAndSubmit'}
                        isSending={props.isCreating}
                        placeholder={t('session.inputPlaceholder')}
                        autocompleteKinds={props.emptyAutocompleteKinds}
                        autocompleteSuggestions={props.emptyAutocompleteSuggestions}
                        extraActionChips={[workflowStart.chip, ...actionChips]}
                        attachmentRowItems={projectedAttachmentRowItems}
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
                        onAgentPickerVisibilityChange={props.onAgentPickerVisibilityChange}
                        onAttachmentsAdded={attachmentsUploadsEnabled ? addWebFiles : undefined}
                        hasSendableAttachments={composerHasSendableAttachments}
                        permissionMode={props.permissionMode}
                        allowedPermissionModes={props.allowedPermissionModes}
                        onPermissionModeChange={props.handlePermissionModeChange}
                        modelMode={props.modelMode}
                        onModelModeChange={props.setModelMode}
                        modelOptionsOverride={props.modelOptions}
                        modelOptionsOverrideProbe={props.modelOptionsProbe}
                        modelContentOverride={props.modelContentOverride}
                        acpSessionModeOptionsOverride={props.acpSessionModeOptions}
                        acpSessionModeSelectedIdOverride={props.acpSessionModeId ?? null}
                        acpSessionModeOptionsOverrideProbe={props.acpSessionModeProbe}
                        onAcpSessionModeChange={
                            (props.acpSessionModeOptions?.length ?? 0) > 0 && props.setAcpSessionModeId
                                ? (modeId) => props.setAcpSessionModeId?.(resolveRequestedSessionModeId(modeId, props.acpSessionModeOptions) || null)
                                : undefined
                        }
                        acpConfigOptionsOverride={props.acpConfigOptions}
                        acpConfigOptionsOverrideProbe={props.acpConfigOptionsProbe}
                        acpConfigOptionOverridesOverride={props.acpConfigOptionOverrides ?? null}
                        onAcpConfigOptionChange={props.setAcpConfigOptionOverride}
                        // Embedded, a ready machine stays quiet (the chip already names it); a machine
                        // that cannot start a session still says so above the card.
                        connectionStatus={embedded && props.connectionStatus?.healthy ? undefined : props.connectionStatus}
                        autoActionBarLayout={embedded ? 'collapsed' : undefined}
                        barControlIds={embedded ? embeddedBarControlIds : undefined}
                        collapseEmptyStatusRow={embedded}
                        statusBadges={props.statusBadges}
                        statusTrailingActions={props.statusTrailingActions}
                        showStatusPermissionMode={false}
                        machineName={props.machineName}
                        machinePopover={props.machinePopover}
                        onMachineClick={undefined}
                        currentPath={props.selectedPath}
                        folderChipState={props.folderChipState}
                        onRemoveFolder={props.onRemoveFolder}
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
                        />}
                        {props.composerDocument?.afterComposer}
                    </PluginContextualResourceStoreProvider>
                    {attachmentsUploadsEnabled ? (
                        <AttachmentFilePicker
                            ref={filePickerRef}
                            onAttachmentsPicked={addPickedAttachments}
                            multiple
                        />
                    ) : null}
                </View>
            </View>
        </View>
    );
}
