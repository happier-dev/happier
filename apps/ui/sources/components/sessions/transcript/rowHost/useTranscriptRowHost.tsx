import * as React from 'react';
import { View } from 'react-native';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import { resolveOlderNeighborRenderedIndex } from '@/components/sessions/transcript/listOrientation';
import type { ChatListInternalProps, ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import { ChatListMessageRow, TranscriptRowShell } from '@/components/sessions/transcript/ChatListRows';
import {
    ChatListFooterWithKeyboardInset,
    ListHeader,
} from '@/components/sessions/transcript/ChatListFrameSlots';
import { deriveReadOnlyTranscriptInteraction } from '@/components/sessions/transcript/forkContext/deriveReadOnlyTranscriptInteraction';
import { ForkDividerRow } from '@/components/sessions/transcript/forkContext/ForkDividerRow';
import { PendingMessagesTranscriptBlock } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { SessionActionDraftCard } from '@/components/sessions/actions/SessionActionDraftCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { ToolCallsGroupUnitHeaderRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow';
import { ToolCallsGroupUnitExpandRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitExpandRow';
import { ToolCallsGroupUnitToolRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow';
import { ToolCallsGroupUnitFooterRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitFooterRow';
import { TranscriptLiveMessagesRowShell } from '@/components/sessions/transcript/rowHost/TranscriptLiveMessagesRowShell';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { resolveTranscriptRowPaintedIdentities } from '@/components/sessions/transcript/motion/transcriptRowPaintedIdentities';
import { resolveTranscriptUtteranceIdentity } from '@/components/sessions/transcript/motion/transcriptFreshnessGate';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import { OlderLoadRetryOverlay } from '@/components/sessions/transcript/OlderLoadRetryOverlay';
import { CatchUpProgressOverlay } from '@/components/sessions/transcript/CatchUpProgressOverlay';
import { resolveTranscriptListShellEdgeSlots } from '@/components/sessions/transcript/viewport/shell/transcriptListShellEdgeSlots';
import {
    resolveTranscriptItemActiveThinkingMessageId,
} from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import type { TranscriptMeasurementReconciler } from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import type { TranscriptItemHeightValiditySignature } from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { TranscriptWindowGapRow } from '@/components/sessions/transcript/viewport/window/TranscriptWindowGapRow';
import {
    ExternalImportProgressCard,
    type ExternalSessionOperationActionRef,
} from '@/components/sessions/external/progress/ExternalImportProgressCard';
import {
    ExternalSessionOperationSharedCard,
} from '@/components/sessions/external/progress/ExternalSessionOperationSharedCard';
import { resolveExternalSessionOperationRowCapabilities } from '@/components/sessions/external/progress/externalSessionOperationRowCapabilities';
import { Modal } from '@/modal';
import {
    machineExternalSessionOperationCancel,
    machineExternalSessionOperationDiscard,
    machineExternalSessionOperationResume,
    machineExternalSessionOperationRetry,
} from '@/sync/ops/machineExternalSessions';
import { t } from '@/text';
import { presentExternalSessionOperationActionError } from '@/components/sessions/external/progress/externalSessionOperationActionErrorPresentation';
import { PluginTranscriptActivityCard } from '@/components/sessions/transcript/PluginTranscriptActivityCard';

type Ref<T> = { current: T };

type ToolCallsGroupExpansionRequest = Readonly<{
    expanded: boolean;
    toolCallsGroupId: string;
    toolMessageIds: readonly string[];
}>;

export type TranscriptItemRendererDeps = Readonly<{
    buildRowShellSignature: (item: ChatTranscriptListItem) => TranscriptItemHeightValiditySignature;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    getMessageById: (messageId: string) => Message | null;
    getMessageRevisionById: (messageId: string) => number | null;
    handleRowLayoutMutation: (params: Readonly<{ itemId: string; mutation: TranscriptRowLayoutMutation; rowKind: string }>) => void;
    handleRowShellMeasured: (params: Readonly<{ itemId: string; rowKind: string; heightPx: number }>) => void;
    itemsRef: Ref<readonly ChatTranscriptListItem[]>;
    listData: readonly ChatTranscriptListItem[];
    listOrientation: TranscriptListOrientation;
    measurementReconciler: TranscriptMeasurementReconciler;
    props: ChatListInternalProps;
    resolveKindForMessageId: (messageId: string) => string | null;
    resolveThinkingExpanded: (messageId: string) => boolean;
    resolveToolCallMessagesForIds: (toolMessageIds: readonly string[]) => ToolCallMessage[];
    setThinkingExpanded: (messageId: string, expanded: boolean) => void;
    setToolCallsGroupExpanded: (request: ToolCallsGroupExpansionRequest) => void;
    toolTimelineChromeMode: unknown;
    toolRouteCommon: ChatListInternalProps['toolRouteCommon'];
}>;

export function useTranscriptItemRenderer(deps: TranscriptItemRendererDeps) {
    const {
        buildRowShellSignature,
        expandedToolCallsAnchorMessageIds,
        getMessageById,
        getMessageRevisionById,
        handleRowLayoutMutation,
        handleRowShellMeasured,
        itemsRef,
        listData,
        listOrientation,
        measurementReconciler,
        resolveKindForMessageId,
        resolveThinkingExpanded,
        resolveToolCallMessagesForIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        toolRouteCommon,
        toolTimelineChromeMode,
    } = deps;
    // ChatList re-renders pass a fresh props object literal with stable fields. Keep row
    // renderer identity derived only from the fields it consumes so unchanged rows retain
    // their mounted render path.
    const {
        activeThinkingMessageId,
        approvalRequests,
        forkCommon,
        forkMessageMetadataById,
        forkedTranscriptEnabled,
        interaction: transcriptInteraction,
        eventEmphasisByMessageId,
        externalSessionOperationOwnerTarget,
        messageDisplayCommon,
        messagePins,
        messagesById,
        metadata,
        onCheckAgainExternalSessionOperation,
        onDismissExternalSessionOperation,
        onDismissPluginTranscriptActivity,
        onOpenPluginTranscriptActivityAction,
        onExternalSessionOperationActionResult,
        onEditPendingMessage,
        onToggleMessagePin,
        rollbackActionsByMessageId,
        rollbackRanges,
        sessionId,
        toolChromeCommon,
    } = deps.props;
    const operationMachineId =
        externalSessionOperationOwnerTarget?.machineId ?? null;
    const sessionServerId =
        externalSessionOperationOwnerTarget?.serverId ?? null;
    const operationRowCapabilities = React.useMemo(
        () => resolveExternalSessionOperationRowCapabilities({
            canSendMessages: transcriptInteraction.canSendMessages,
            hasOperationMachineTarget: operationMachineId !== null,
            machineStatusKnown:
                externalSessionOperationOwnerTarget?.machineStatusKnown === true,
            machineOnline:
                externalSessionOperationOwnerTarget?.machineOnline === true,
        }),
        [
            externalSessionOperationOwnerTarget?.machineOnline,
            externalSessionOperationOwnerTarget?.machineStatusKnown,
            operationMachineId,
            transcriptInteraction.canSendMessages,
        ],
    );
    const invokeExternalSessionOperationAction = React.useCallback(async (
        action:
            | typeof machineExternalSessionOperationResume
            | typeof machineExternalSessionOperationRetry
            | typeof machineExternalSessionOperationCancel
            | typeof machineExternalSessionOperationDiscard,
        actionRef: ExternalSessionOperationActionRef,
    ) => {
        if (!operationMachineId) {
            Modal.alert(
                t('common.error'),
                t('chatFooter.externalSessionStatusUnavailable'),
            );
            return;
        }
        try {
            const result = await action({
                machineId: operationMachineId,
                sessionId,
                ...actionRef,
            }, sessionServerId ? { serverId: sessionServerId } : undefined);
            if (!result.ok) {
                Modal.alert(
                    t('common.error'),
                    t(presentExternalSessionOperationActionError(result.error.code)),
                );
                return;
            }
            if (result.progress.operationId !== actionRef.operationId) {
                Modal.alert(
                    t('common.error'),
                    t('externalSessions.operationActionErrorUnavailable'),
                );
                return;
            }
            onExternalSessionOperationActionResult(result.progress);
        } catch {
            Modal.alert(
                t('common.error'),
                t('externalSessions.operationActionErrorUnavailable'),
            );
        }
    }, [
        onExternalSessionOperationActionResult,
        operationMachineId,
        sessionId,
        sessionServerId,
    ]);
    /**
     * Carry the pending block's painted bubble height to the committed row that will replace it.
     *
     * The geometry scope comes from the PENDING row's own signature, so a measurement taken at one
     * width or font scale can never be served to a row rendered at another — the same scoping the
     * reconciler's floors use.
     */
    // The geometry the pending row was last rendered at. Held in a ref rather than closed over, so
    // the callback below keeps ONE identity across renders: it lands in the block's `renderMessage`
    // dependency array, and a fresh arrow per render would rebuild that callback — and with it the
    // whole pending list — on every parent commit, on the send frame this change exists to protect.
    const pendingRowGeometryRef = React.useRef<{ widthBucket: string; fontScaleKey: string } | null>(null);
    const recordPaintedUtteranceBubbleHeight = React.useCallback((measurement: Readonly<{
        localId: string;
        bubbleHeightPx: number;
    }>) => {
        const identity = resolveTranscriptUtteranceIdentity(measurement.localId);
        const geometry = pendingRowGeometryRef.current;
        if (identity === null || geometry === null) return;
        measurementReconciler.recordPaintedUtteranceBubbleHeight({
            identity,
            bubbleHeightPx: measurement.bubbleHeightPx,
            widthBucket: geometry.widthBucket,
            fontScaleKey: geometry.fontScaleKey,
        });
    }, [measurementReconciler]);

    const wrapTranscriptItemForAnchor = React.useCallback((item: ChatTranscriptListItem, node: React.ReactNode) => {
        const signature = buildRowShellSignature(item);
        return (
            <TranscriptRowShell
                reconciler={measurementReconciler}
                itemId={item.id}
                onRowLayoutMutation={handleRowLayoutMutation}
                onRowMeasured={handleRowShellMeasured}
                signature={signature}
            >
                {node}
            </TranscriptRowShell>
        );
    }, [buildRowShellSignature, handleRowLayoutMutation, handleRowShellMeasured, measurementReconciler]);

    const renderItem = React.useCallback(({ item, index }: { item: ChatTranscriptListItem; index: number }) => {
        if (item.kind === 'transcript-window-gap') {
            // Projection-only pagination geometry must not publish an anchor
            // identity that disappears as soon as the window closes the gap.
            return <TranscriptWindowGapRow gap={item} />;
        }
        if (item.kind === 'action-draft') {
            return wrapTranscriptItemForAnchor(item, <SessionActionDraftCard sessionId={sessionId} draft={item.draft} />);
        }
        if (item.kind === 'fork-divider') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={0}>
                    <ForkDividerRow
                        parentSessionId={item.parentSessionId}
                        childSessionId={item.childSessionId}
                        parentCutoffSeqInclusive={item.parentCutoffSeqInclusive}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'pending-queue') {
            const createdAt = item.pendingMessages[0]?.createdAt ?? item.discardedMessages[0]?.createdAt ?? 0;
            const pendingRowSignature = buildRowShellSignature(item);
            pendingRowGeometryRef.current = {
                widthBucket: pendingRowSignature.widthBucket,
                fontScaleKey: pendingRowSignature.fontScaleKey,
            };
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper
                    id={item.id}
                    createdAt={createdAt}
                    paintedIds={resolveTranscriptRowPaintedIdentities(item, getMessageById)}
                >
                    <PendingMessagesTranscriptBlock
                        sessionId={sessionId}
                        pendingMessages={item.pendingMessages}
                        discardedMessages={item.discardedMessages}
                        onEditPendingMessage={onEditPendingMessage}
                        onPaintedUtteranceBubbleMeasured={recordPaintedUtteranceBubbleHeight}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'pending-user-action') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <UserActionPromptCard
                        chrome="card"
                        request={item.request}
                        location={null}
                        sessionId={sessionId}
                        metadata={metadata}
                        canApprovePermissions={transcriptInteraction.permissionDisabledReason === 'inactive'
                            ? true
                            : transcriptInteraction.canApprovePermissions}
                        disabledReason={transcriptInteraction.permissionDisabledReason === 'inactive'
                            ? undefined
                            : transcriptInteraction.permissionDisabledReason}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'external-session-operation') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    {item.progress ? (
                        <ExternalImportProgressCard
                            progress={item.progress}
                            observationContext="hydrated"
                            originAvailability={operationRowCapabilities.originAvailability}
                            onDismiss={onDismissExternalSessionOperation}
                            onResume={operationRowCapabilities.canInvokeOwnerActions
                                ? async (actionRef) =>
                                await invokeExternalSessionOperationAction(
                                    machineExternalSessionOperationResume,
                                    actionRef,
                                )
                                : undefined}
                            onRetry={operationRowCapabilities.canInvokeOwnerActions
                                ? async (actionRef) =>
                                await invokeExternalSessionOperationAction(
                                    machineExternalSessionOperationRetry,
                                    actionRef,
                                )
                                : undefined}
                            onCancel={operationRowCapabilities.canInvokeOwnerActions
                                ? async (actionRef) =>
                                await invokeExternalSessionOperationAction(
                                    machineExternalSessionOperationCancel,
                                    actionRef,
                                )
                                : undefined}
                            onDiscard={operationRowCapabilities.canInvokeOwnerActions
                                ? async (actionRef) =>
                                await invokeExternalSessionOperationAction(
                                    machineExternalSessionOperationDiscard,
                                    actionRef,
                                )
                                : undefined}
                        />
                    ) : (
                        <ExternalSessionOperationSharedCard
                            presentation={item.presentation}
                            onDismiss={onDismissExternalSessionOperation}
                            {...(onCheckAgainExternalSessionOperation
                                ? { onCheckAgain: onCheckAgainExternalSessionOperation }
                                : {})}
                        />
                    )}
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'plugin-transcript-activity') {
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <PluginTranscriptActivityCard
                        activity={item}
                        onDismiss={onDismissPluginTranscriptActivity}
                        onOpenAction={onOpenPluginTranscriptActivityAction}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'tool-calls-group') {
            const interaction = deriveReadOnlyTranscriptInteraction(transcriptInteraction, item.isReadOnlyContext === true);
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupRowWithSessionCommon
                    sessionId={sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={metadata}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={interaction}
                    approvalRequests={approvalRequests}
                    getMessageById={forkedTranscriptEnabled ? getMessageById : undefined}
                    messagePins={messagePins}
                    onToggleToolPin={onToggleMessagePin}
                    forkCommon={forkCommon}
                    messageDisplayCommon={messageDisplayCommon}
                    toolChromeCommon={toolChromeCommon}
                    toolRouteCommon={toolRouteCommon}
                />
            ));
        }
        if (item.kind === 'tool-group-header') {
            const interaction = deriveReadOnlyTranscriptInteraction(transcriptInteraction, item.isReadOnlyContext === true);
            const headerToolMessageIds = item.toolMessageIds;
            const headerGroupId = item.groupId;
            const initialToolMessages = resolveToolCallMessagesForIds(item.toolMessageIds);
            const messageRefs = item.toolMessageIds.map((messageId) => ({
                sessionId: forkMessageMetadataById?.[messageId]?.originSessionId ?? sessionId,
                messageId,
            }));
            return (
                <TranscriptLiveMessagesRowShell
                    item={item}
                    messageRefs={messageRefs}
                    initialMessages={initialToolMessages}
                    buildRowShellSignature={buildRowShellSignature}
                    measurementReconciler={measurementReconciler}
                    onRowLayoutMutation={handleRowLayoutMutation}
                    onRowMeasured={handleRowShellMeasured}
                >
                    {(messages) => (
                        <ToolCallsGroupUnitHeaderRowWithSessionCommon
                            sessionId={sessionId}
                            groupId={item.groupId}
                            metadata={metadata}
                            interaction={interaction}
                            toolMessages={messages.filter((message): message is ToolCallMessage => message.kind === 'tool-call')}
                            expanded={item.expanded}
                            setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                                toolCallsGroupId: headerGroupId,
                                toolMessageIds: headerToolMessageIds,
                                expanded,
                            })}
                            forkCommon={forkCommon}
                            messageDisplayCommon={messageDisplayCommon}
                            toolChromeCommon={toolChromeCommon}
                            toolRouteCommon={toolRouteCommon}
                        />
                    )}
                </TranscriptLiveMessagesRowShell>
            );
        }
        if (item.kind === 'tool-group-expand') {
            const interaction = deriveReadOnlyTranscriptInteraction(transcriptInteraction, item.isReadOnlyContext === true);
            const expandToolMessageIds = item.toolMessageIds;
            const expandGroupId = item.groupId;
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitExpandRowWithSessionCommon
                    sessionId={sessionId}
                    groupId={item.groupId}
                    metadata={metadata}
                    interaction={interaction}
                    hiddenCount={item.hiddenCount}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: expandGroupId,
                        toolMessageIds: expandToolMessageIds,
                        expanded,
                    })}
                    forkCommon={forkCommon}
                    messageDisplayCommon={messageDisplayCommon}
                    toolChromeCommon={toolChromeCommon}
                    toolRouteCommon={toolRouteCommon}
                />
            ));
        }
        if (item.kind === 'tool-group-tool') {
            const interaction = deriveReadOnlyTranscriptInteraction(transcriptInteraction, item.isReadOnlyContext === true);
            const toolMessage = getMessageById(item.toolMessageId);
            const messageRefs = [{
                sessionId: forkMessageMetadataById?.[item.toolMessageId]?.originSessionId ?? item.originSessionId ?? sessionId,
                messageId: item.toolMessageId,
            }];
            return (
                <TranscriptLiveMessagesRowShell
                    item={item}
                    messageRefs={messageRefs}
                    initialMessages={toolMessage ? [toolMessage] : []}
                    buildRowShellSignature={buildRowShellSignature}
                    measurementReconciler={measurementReconciler}
                    onRowLayoutMutation={handleRowLayoutMutation}
                    onRowMeasured={handleRowShellMeasured}
                >
                    {(messages) => {
                        const message = messages[0];
                        return message?.kind === 'tool-call' ? (
                            <ToolCallsGroupUnitToolRowWithSessionCommon
                                sessionId={sessionId}
                                groupId={item.groupId}
                                metadata={metadata}
                                interaction={interaction}
                                message={message}
                                expanded={item.expanded}
                                approvalRequests={approvalRequests}
                                messagePins={messagePins}
                                onToggleToolPin={onToggleMessagePin}
                                forkCommon={forkCommon}
                                messageDisplayCommon={messageDisplayCommon}
                                toolChromeCommon={toolChromeCommon}
                                toolRouteCommon={toolRouteCommon}
                            />
                        ) : null;
                    }}
                </TranscriptLiveMessagesRowShell>
            );
        }
        if (item.kind === 'tool-group-footer') {
            const interaction = deriveReadOnlyTranscriptInteraction(transcriptInteraction, item.isReadOnlyContext === true);
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitFooterRowWithSessionCommon
                    sessionId={sessionId}
                    groupId={item.groupId}
                    metadata={metadata}
                    interaction={interaction}
                    forkCommon={forkCommon}
                    messageDisplayCommon={messageDisplayCommon}
                    toolChromeCommon={toolChromeCommon}
                    toolRouteCommon={toolRouteCommon}
                />
            ));
        }
        if (item.kind === 'message') {
            const rowActiveThinkingMessageId = resolveTranscriptItemActiveThinkingMessageId(item, activeThinkingMessageId);
            const toolChromeMode = toolTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
            const neighborItems = listData[index]?.id === item.id
                ? listData
                : itemsRef.current;
            const olderNeighborIndex = resolveOlderNeighborRenderedIndex(
                index,
                neighborItems.length,
                listOrientation,
            );
            const prev = olderNeighborIndex != null
                ? neighborItems[olderNeighborIndex]
                : undefined;
            const shouldTightenToolStack =
                toolChromeMode === 'activity_feed' &&
                resolveKindForMessageId(item.messageId) === 'tool-call' &&
                prev?.kind === 'message' &&
                resolveKindForMessageId(prev.messageId) === 'tool-call';
            const wrapperStyle = shouldTightenToolStack ? { marginTop: -12 } : undefined;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper
                    id={item.id}
                    createdAt={item.createdAt}
                    paintedIds={resolveTranscriptRowPaintedIdentities(item, getMessageById)}
                >
                    <View style={wrapperStyle}>
                        <ChatListMessageRow
                            sessionId={sessionId}
                            messageId={item.messageId}
                            messageOverride={item.originSessionId ? (messagesById[item.messageId] ?? null) : undefined}
                            originSessionId={item.originSessionId}
                            isReadOnlyContext={item.isReadOnlyContext}
                            getMessageRevisionById={getMessageRevisionById}
                            metadata={metadata}
                            activeThinkingMessageId={rowActiveThinkingMessageId}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                            interaction={transcriptInteraction}
                            eventEmphasisByMessageId={eventEmphasisByMessageId}
                            rollbackAction={rollbackActionsByMessageId[item.messageId] ?? null}
                            rollbackRanges={rollbackRanges}
                            approvalRequests={approvalRequests}
                            messagePins={messagePins}
                            onToggleMessagePin={onToggleMessagePin}
                            forkCommon={forkCommon}
                            messageDisplayCommon={messageDisplayCommon}
                            toolChromeCommon={toolChromeCommon}
                            toolRouteCommon={toolRouteCommon}
                        />
                    </View>
                </TranscriptEnterWrapper>
            ));
        }
        return null;
    }, [
        expandedToolCallsAnchorMessageIds,
        getMessageById,
        getMessageRevisionById,
        invokeExternalSessionOperationAction,
        itemsRef,
        listData,
        listOrientation,
        activeThinkingMessageId,
        approvalRequests,
        forkCommon,
        forkMessageMetadataById,
        forkedTranscriptEnabled,
        transcriptInteraction,
        eventEmphasisByMessageId,
        externalSessionOperationOwnerTarget,
        messageDisplayCommon,
        messagePins,
        messagesById,
        metadata,
        operationRowCapabilities,
        onCheckAgainExternalSessionOperation,
        onDismissExternalSessionOperation,
        onDismissPluginTranscriptActivity,
        onOpenPluginTranscriptActivityAction,
        onExternalSessionOperationActionResult,
        onEditPendingMessage,
        onToggleMessagePin,
        rollbackActionsByMessageId,
        rollbackRanges,
        sessionId,
        toolChromeCommon,
        resolveKindForMessageId,
        resolveThinkingExpanded,
        resolveToolCallMessagesForIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        toolRouteCommon,
        toolTimelineChromeMode,
        wrapTranscriptItemForAnchor,
    ]);
    const renderTranscriptItemAtIndex = React.useCallback((item: ChatTranscriptListItem, index: number) => {
        return renderItem({ item, index });
    }, [renderItem]);

    return React.useMemo(() => ({
        renderItem,
        renderTranscriptItemAtIndex,
    }), [renderItem, renderTranscriptItemAtIndex]);
}

export type TranscriptItemsEdgeSlotsDeps = Readonly<{
    bottomNotice: ChatListInternalProps['bottomNotice'];
    composerInsetHeight: number;
    controlSwitchTo: ChatListInternalProps['controlSwitchTo'];
    controlledByUserOverride: ChatListInternalProps['controlledByUserOverride'];
    externalControlFooter: ChatListInternalProps['externalControlFooter'];
    handleComposerInsetHeightChange: (height: number) => void;
    isLoadingOlder: boolean;
    mainTranscriptListShellFrame: Parameters<typeof resolveTranscriptListShellEdgeSlots>[0]['frame'];
    onRequestSwitchToRemote: ChatListInternalProps['onRequestSwitchToRemote'];
    olderPaginationIsLoadingOlder: boolean;
    olderPaginationLoadFailed: boolean;
    onRetryOlderPagination: () => void;
    renderTranscriptItemAtIndex: (item: ChatTranscriptListItem, index: number) => React.ReactNode;
    sessionId: string;
    showCatchUpOverlay: boolean;
    showFirstPaintPlaceholder: boolean;
    transcriptOlderLoadSpinnerDelayMs: number;
}>;

export function useTranscriptItemsEdgeSlots(deps: TranscriptItemsEdgeSlotsDeps) {
    const {
        bottomNotice,
        composerInsetHeight,
        controlSwitchTo,
        controlledByUserOverride,
        externalControlFooter,
        handleComposerInsetHeightChange,
        isLoadingOlder,
        mainTranscriptListShellFrame,
        onRequestSwitchToRemote,
        olderPaginationIsLoadingOlder,
        olderPaginationLoadFailed,
        onRetryOlderPagination,
        renderTranscriptItemAtIndex,
        sessionId,
        showCatchUpOverlay,
        showFirstPaintPlaceholder,
        transcriptOlderLoadSpinnerDelayMs,
    } = deps;
    const listHeaderNode = React.useMemo(() => (
        <ListHeader />
    ), []);
    const listFooterNode = React.useMemo(() => (
        <ChatListFooterWithKeyboardInset
            sessionId={sessionId}
            bottomNotice={bottomNotice}
            controlledByUserOverride={controlledByUserOverride}
            controlSwitchTo={controlSwitchTo ?? null}
            onRequestSwitchToRemote={onRequestSwitchToRemote}
            externalControl={externalControlFooter}
            onComposerInsetHeightChange={handleComposerInsetHeightChange}
        />
    ), [
        bottomNotice,
        controlSwitchTo,
        controlledByUserOverride,
        externalControlFooter,
        handleComposerInsetHeightChange,
        onRequestSwitchToRemote,
        sessionId,
    ]);
    const edgeSlots = React.useMemo(() => resolveTranscriptListShellEdgeSlots({
        frame: mainTranscriptListShellFrame,
        visualTopNode: listHeaderNode,
        visualBottomNode: listFooterNode,
    }), [listFooterNode, listHeaderNode, mainTranscriptListShellFrame]);
    const olderLoadOverlay = showFirstPaintPlaceholder
        ? null
        : (olderPaginationIsLoadingOlder || isLoadingOlder)
            ? <OlderLoadProgressOverlay />
            : olderPaginationLoadFailed
                ? <OlderLoadRetryOverlay onRetry={onRetryOlderPagination} />
                : null;
    const catchUpOverlay = (
        <CatchUpProgressOverlay
            isCatchingUp={showCatchUpOverlay}
            bottomInset={composerInsetHeight}
            spinnerDelayMs={transcriptOlderLoadSpinnerDelayMs}
        />
    );

    return React.useMemo(() => ({
        catchUpOverlay,
        edgeSlots,
        olderLoadOverlay,
    }), [catchUpOverlay, edgeSlots, olderLoadOverlay]);
}
