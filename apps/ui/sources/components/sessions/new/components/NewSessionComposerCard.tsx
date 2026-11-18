import * as React from 'react';
import { useAtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';
import { useAtmosphereSendSignal } from '@/components/atmosphere/atmosphereStage';
import { resolveRequestedSessionModeId } from '@happier-dev/protocol/actions/sessionModeIds';
import { View, useWindowDimensions } from 'react-native';

import { AgentInput } from '@/components/sessions/agentInput';
import { Item } from '@/components/ui/lists/Item';
import { OrganizationPolicyManagedLine } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { getPermissionModeLabelForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import { projectAgentInputAttachmentRowItems } from '@/components/sessions/agentInput/agentInputContracts';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { t } from '@/text';
import { useNewSessionAttachmentsController } from '@/components/sessions/new/attachments/useNewSessionAttachmentsController';
import { resolveAvailablePanelHeight } from '@/components/sessions/keyboardAvoidance/composerKeyboardGeometry';
import { useComposerAvailablePanelHeight } from '@/components/sessions/keyboardAvoidance/useComposerAvailablePanelHeight';
import { computeNewSessionComposerPanelMaxHeight } from '@/components/sessions/agentInput/inputMaxHeight';
import { NewSessionProviderLaunchError } from '@/components/sessions/new/components/NewSessionProviderLaunchError';
import { SessionIsolationOutcomeLine, sessionIsolationOutcomeSaysMachineStatus } from '@/components/sessions/new/placement/SessionIsolationOutcomeLine';
import { NewSessionRequesterFolderHint } from '@/components/sessions/new/components/NewSessionRequesterFolderHint';
import { NewSessionCreationReviewLine } from '@/components/sessions/new/components/NewSessionCreationReviewLine';
import { NewSessionLaunchApprovalNotice } from '@/components/sessions/new/components/NewSessionLaunchApprovalNotice';
import { useComposerTextSelector } from '@/components/sessions/agentInput/composerTextStore';
import { isNewSessionComposerEditable } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { useNewSessionWorkflowStart } from '../hooks/useNewSessionWorkflowStart';
import { useNewSessionEmbeddedHost, useNewSessionHostNavigation } from '../navigation/newSessionHost';
import { router as appRouter, type Href } from 'expo-router';
import { useNewSessionBackgroundLaunchStatus } from './useNewSessionBackgroundLaunchStatus';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';

const isEmptyComposerText = (text: string): boolean => text.length === 0;

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
    /** `compact`: the composer keeps only machine and model (an embedding page's ask box). */
    controlPreset?: 'full' | 'compact';
    /** Creation forms reuse the canonical controls beside their own explicit Create action. */
    inputPresentation?: React.ComponentProps<typeof AgentInput>['inputPresentation'];
    /** The screen host seats a selected workflow in its working surface. */
    onWorkflowSelectionChange?: (selected: boolean) => void;
}>): React.ReactElement {
    const props = input.panelProps;
    const embedded = input.layout === 'embedded';
    const atmosphereBoundary = useAtmosphereBandBoundary();
    useAtmosphereSendSignal(!embedded && props.isCreating);
    const onComposerFocusChange = React.useCallback((focused: boolean) => {
        props.composerDocument?.onComposerFocusChange?.(focused);
        atmosphereBoundary?.onFocusChange(focused);
    }, [atmosphereBoundary, props.composerDocument]);
    const reservedHeight = input.reservedHeight ?? 0;
    const {
        attachmentsUploadsEnabled,
        filePickerRef,
        hasSendableAttachments,
        agentInputAttachments,
        addWebFiles,
        attachmentDropHint,
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

    // The input leaf inside AgentInput subscribes to the prompt store itself, so a keystroke
    // re-renders that leaf and nothing above it. This card follows only whether the text is empty.
    const composerEmpty = useComposerTextSelector(props.promptStore, isEmptyComposerText);
    // The host's line belongs to an empty composer: typing or the next send hands the row back.
    const embeddedHost = useNewSessionEmbeddedHost();
    const hostNavigation = useNewSessionHostNavigation();
    const openStartedSession = React.useMemo(() => embeddedHost?.onOpenStartedSession
        ?? ((href: string) => { appRouter.push(href as Href); }), [embeddedHost?.onOpenStartedSession]);
    const openStartedDraft = React.useCallback((draftId: string) => {
        hostNavigation.openDraft({ draftId, draftOrigin: null });
    }, [hostNavigation]);
    const backgroundLaunchStatus = useNewSessionBackgroundLaunchStatus({ openSession: openStartedSession, openDraft: openStartedDraft });
    const connectionStatus: typeof props.connectionStatus = backgroundLaunchStatus !== undefined && composerEmpty && !props.isCreating
        ? backgroundLaunchStatus : props.connectionStatus;
    // A chosen workflow swaps the composer, not the host: the same status line, inset and width carry over.
    const workflowStart = useNewSessionWorkflowStart({ panelProps: props, prompt: props.promptStore, surfaceGroup: input.surfaceGroup,
        host: { connectionStatus, contentPaddingHorizontal: 0, ...(embedded ? { maxWidthCap: null } : {}) } });
    const workflowSelected = workflowStart.composer !== null;
    // One cause, one line: when the outcome line under the composer says the Machine is offline or absent (and what happens to
    // the draft), the status line above says nothing more about the Machine. A chosen workflow shows no outcome line,
    // so its composer keeps the status.
    const outcomeSaysMachineStatus = !workflowSelected && props.sessionIsolation !== undefined
        && sessionIsolationOutcomeSaysMachineStatus(props.sessionIsolation);
    const sessionConnectionStatus = outcomeSaysMachineStatus && connectionStatus?.recovery === 'machine' ? undefined : connectionStatus;
    React.useLayoutEffect(() => {
        input.onWorkflowSelectionChange?.(workflowSelected);
    }, [input.onWorkflowSelectionChange, workflowSelected]);
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
    // A page column scrolls, so a long draft stays inside the composer and Send stays on the page.
    const maxPanelHeight = computeNewSessionComposerPanelMaxHeight({
        mode: embedded ? 'wizard' : 'simple',
        availablePanelHeight: availablePanelHeight ?? initialAvailablePanelHeight,
        reservedHeight: reservedHeight,
        viewportHeight: windowHeight,
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
                    <NewSessionLaunchApprovalNotice approval={props.launchApproval} />
                    <NewSessionRequesterFolderHint isolation={props.requesterIsolation} />
                    <NewSessionCreationReviewLine summary={props.creationReviewSummary} />
                    <PluginContextualResourceStoreProvider>
                        {props.composerDocument?.beforeComposer}
                        {props.composerTopContent ? (
                            <View ref={embeddedHost?.composerTopContentRef} collapsable={false}>{props.composerTopContent}</View>
                        ) : null}
                        {/* Only a policy lock earns a line of its own; an inherited Team or Group default is named in the permission picker. */}
                        {props.permissionModeLock ? <Item
                            testID="new-session-managed-permission"
                            title={getPermissionModeLabelForAgentType(props.agentType ?? '', props.permissionMode ?? 'default')}
                            subtitle={<OrganizationPolicyManagedLine lock={props.permissionModeLock} />}
                            showChevron={false}
                        /> : null}
                        {/* The atmosphere's band and hero follow the composer itself. A docked host seats its own
                            band on what is stacked above it too (`composerTopContentRef`). */}
                        <View testID="new-session-composer-band" ref={atmosphereBoundary?.ref} onLayout={atmosphereBoundary?.onLayout}>
                        {workflowStart.composer ?? <AgentInput
                        statusRegions={props.composerDocument?.statusRegions}
                        surfaceGroup={input.surfaceGroup}
                        value={props.promptStore}
                        onChangeText={props.setSessionPrompt}
                        structuredInputMentions={props.composerDocument?.structuredInputMentions}
                        onStructuredInputMentionsChange={props.composerDocument?.onStructuredInputMentionsChange}
                        onComposerFocusChange={onComposerFocusChange}
                        onComposerFocusRequestChange={props.composerDocument?.onComposerFocusRequestChange}
                        onComposerBlurRequestChange={props.composerDocument?.onComposerBlurRequestChange}
                        onPromptPickerOpenRequestChange={props.composerDocument?.onPromptPickerOpenRequestChange}
                        composerRef={props.composerDocument?.ref}
                        composerReferenceHost={props.composerReferenceHost}
                        composerFileScope={props.composerFileScope}
                        onComposerInputFlushRequestChange={props.composerDocument?.onComposerInputFlushRequestChange}
                        onComposerActionBarLayoutChange={props.composerDocument?.onComposerActionBarLayoutChange}
                        panelHostRef={embeddedHost?.composerPanelRef}
                        inputPersistence={props.composerDocument?.inputPersistence}
                        composerDecorations={props.composerDocument?.composerDecorations ?? []}
                        composerInputLock={props.composerDocument?.composerInputLock ?? null}
                        onSend={handleSend}
                        newSessionAfterSendMode={props.newSessionAfterSendMode}
                        inputPresentation={input.inputPresentation}
                        {...(input.voiceAffordance === 'none' ? { voiceAffordance: 'none' as const } : {})}
                        {...(input.controlPreset ? { controlPreset: input.controlPreset } : {})}
                        isSendDisabled={!props.canCreate || (props.composerDocument?.composerInputLock ?? null) !== null}
                        disabled={!isNewSessionComposerEditable({
                            isSubmitting: props.isCreating,
                            inputLock: props.composerDocument?.composerInputLock,
                        })}
                        isSending={props.isCreating}
                        placeholder={props.inputPlaceholder ?? t('session.inputPlaceholder')}
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
                        attachmentDropHint={attachmentDropHint}
                        hasSendableAttachments={composerHasSendableAttachments}
                        permissionMode={props.permissionMode}
                        nativeSandbox={props.nativeSandbox}
                        allowedPermissionModes={props.allowedPermissionModes}
                        onPermissionModeChange={props.permissionModeLock ? undefined : props.handlePermissionModeChange}
                        permissionModeAttribution={props.permissionModeAttribution}
                        modelMode={props.modelMode}
                        modelPickerPresentation={props.modelPickerPresentation}
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
                        acpModelConfigOptionIdOverride={props.acpModelConfigOptionId}
                        acpConfigOptionsOverrideProbe={props.acpConfigOptionsProbe}
                        acpConfigOptionOverridesOverride={props.acpConfigOptionOverrides ?? null}
                        onAcpConfigOptionChange={props.setAcpConfigOptionOverride}
                        // A machine that cannot start a session says so above the card; a ready one is quiet.
                        connectionStatus={sessionConnectionStatus}
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
                        // An embedding host's column supplies the card's width (Docked may be widened past the
                        // reading width); only the `/new` screen keeps the conversation column's cap.
                        {...(embedded ? { maxWidthCap: null } : {})}
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
                        </View>
                        {props.sessionIsolation && !workflowSelected ? (
                            <SessionIsolationOutcomeLine serverId={props.sessionIsolation.serverId} machineName={props.sessionIsolation.machineName}
                                snapshot={props.sessionIsolation.snapshot} outcome={props.sessionIsolation.proposedOutcome}
                                offline={props.sessionIsolation.offline}
                                managedPresence={props.sessionIsolation.managedPresence}
                                override={props.sessionIsolation.override} onOverrideChange={props.sessionIsolation.onOverrideChange}
                                {...(props.sessionIsolation.onProjectFilesChange ? { projectFiles: {
                                    source: props.sessionIsolation.projectFilesOutcome?.source,
                                    override: props.sessionIsolation.projectFilesOverride,
                                    onChange: props.sessionIsolation.onProjectFilesChange } } : {})} />
                        ) : null}
                        {props.composerBottomContent}
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
