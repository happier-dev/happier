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
import { TurnViewWithSessionCommon } from '@/components/sessions/transcript/turns/TurnView';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { ToolCallsGroupUnitHeaderRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow';
import { ToolCallsGroupUnitExpandRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitExpandRow';
import { ToolCallsGroupUnitToolRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow';
import { ToolCallsGroupUnitFooterRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitFooterRow';
import { TranscriptLiveMessagesRowShell } from '@/components/sessions/transcript/rowHost/TranscriptLiveMessagesRowShell';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { resolveTranscriptRowPaintedIdentities } from '@/components/sessions/transcript/motion/transcriptRowPaintedIdentities';
import { resolveTranscriptUtteranceIdentity } from '@/components/sessions/transcript/motion/transcriptFreshnessGate';
import { TranscriptHotTail } from '@/components/sessions/transcript/segments/TranscriptHotTail';
import { WebTranscriptSplitFooter } from '@/components/sessions/transcript/web/WebTranscriptSplitFooter';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import { CatchUpProgressOverlay } from '@/components/sessions/transcript/CatchUpProgressOverlay';
import { resolveTranscriptListShellEdgeSlots } from '@/components/sessions/transcript/viewport/shell/transcriptListShellEdgeSlots';
import {
    resolveTranscriptItemActiveThinkingMessageId,
} from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import type { TranscriptMeasurementReconciler } from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import type { TranscriptItemHeightValiditySignature } from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import type { TranscriptRollbackAction } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { TranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import { TranscriptWindowGapRow } from '@/components/sessions/transcript/viewport/window/TranscriptWindowGapRow';

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
    getMessageOrigin: ((messageId: string) => { sessionId: string; isReadOnlyContext: boolean } | null) | undefined;
    getMessageRevisionById: (messageId: string) => number | null;
    handleRowLayoutMutation: (params: Readonly<{ itemId: string; mutation: TranscriptRowLayoutMutation; rowKind: string }>) => void;
    handleRowShellMeasured: (params: Readonly<{ itemId: string; rowKind: string; heightPx: number }>) => void;
    itemsRef: Ref<readonly ChatTranscriptListItem[]>;
    listData: readonly ChatTranscriptListItem[];
    listOrientation: TranscriptListOrientation;
    measurementReconciler: TranscriptMeasurementReconciler;
    props: ChatListInternalProps;
    resolveCreatedAtForMessageId: (messageId: string) => number | null;
    resolveKindForMessageId: (messageId: string) => string | null;
    resolveRollbackActionForMessage: (messageId: string) => TranscriptRollbackAction | null;
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
        getMessageOrigin,
        getMessageRevisionById,
        handleRowLayoutMutation,
        handleRowShellMeasured,
        itemsRef,
        listData,
        listOrientation,
        measurementReconciler,
        resolveCreatedAtForMessageId,
        resolveKindForMessageId,
        resolveRollbackActionForMessage,
        resolveThinkingExpanded,
        resolveToolCallMessagesForIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        toolRouteCommon,
        toolTimelineChromeMode,
    } = deps;
    // renderItem identity gates FlashList view-holder bailout (ViewHolder memo compares it
    // with ===). ChatList re-renders pass a fresh props object literal with stable fields,
    // so identity must derive from the fields this renderer actually uses.
    const {
        activeThinkingMessageId,
        approvalRequests,
        forkCommon,
        forkedTranscriptEnabled,
        interaction: transcriptInteraction,
        messageDisplayCommon,
        messagePins,
        messagesById,
        eventEmphasisByMessageId,
        metadata,
        onEditPendingMessage,
        onToggleMessagePin,
        rollbackActionsByMessageId,
        rollbackRanges,
        sessionId,
        toolChromeCommon,
    } = deps.props;
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
            // Pagination gaps are in-flow recycler geometry only. Publishing a
            // `transcript-item-*` shell would let web/native visible-anchor owners
            // select a synthetic identity that disappears as soon as the gap closes.
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
                sessionId: getMessageOrigin?.(messageId)?.sessionId ?? sessionId,
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
                sessionId: getMessageOrigin?.(item.toolMessageId)?.sessionId ?? item.originSessionId ?? sessionId,
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
        if (item.kind === 'turn') {
            const rowActiveThinkingMessageId = resolveTranscriptItemActiveThinkingMessageId(item, activeThinkingMessageId);
            const turnCreatedAt =
                (item.turn.userMessageId ? resolveCreatedAtForMessageId(item.turn.userMessageId) : null) ??
                (item.turn.content[0]?.kind === 'message'
                    ? resolveCreatedAtForMessageId(item.turn.content[0].messageId)
                    : item.turn.content[0]?.kind === 'tool_calls'
                        ? (item.turn.content[0].toolMessageIds[0]
                            ? resolveCreatedAtForMessageId(item.turn.content[0].toolMessageIds[0])
                            : null)
                        : null) ??
                0;
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper
                    id={item.id}
                    createdAt={turnCreatedAt}
                    paintedIds={resolveTranscriptRowPaintedIdentities(item, getMessageById)}
                >
                    <TurnViewWithSessionCommon
                        turn={item.turn}
                        metadata={metadata}
                        sessionId={sessionId}
                        interaction={transcriptInteraction}
                        activeThinkingMessageId={rowActiveThinkingMessageId}
                        getMessageById={getMessageById}
                        getMessageRevisionById={getMessageRevisionById}
                        getMessageOrigin={getMessageOrigin}
                        approvalRequests={approvalRequests}
                        messagePins={messagePins}
                        onToggleMessagePin={onToggleMessagePin}
                        rollbackRanges={rollbackRanges}
                        resolveRollbackAction={resolveRollbackActionForMessage}
                        eventEmphasisByMessageId={eventEmphasisByMessageId}
                        resolveThinkingExpanded={resolveThinkingExpanded}
                        setThinkingExpanded={setThinkingExpanded}
                        expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                        setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                        forkCommon={forkCommon}
                        messageDisplayCommon={messageDisplayCommon}
                        toolChromeCommon={toolChromeCommon}
                        toolRouteCommon={toolRouteCommon}
                    />
                </TranscriptEnterWrapper>
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
                            rollbackAction={rollbackActionsByMessageId[item.messageId] ?? null}
                            rollbackRanges={rollbackRanges}
                            eventEmphasisByMessageId={eventEmphasisByMessageId}
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
        getMessageOrigin,
        getMessageRevisionById,
        itemsRef,
        listData,
        listOrientation,
        activeThinkingMessageId,
        approvalRequests,
        forkCommon,
        forkedTranscriptEnabled,
        transcriptInteraction,
        messageDisplayCommon,
        messagePins,
        messagesById,
        eventEmphasisByMessageId,
        metadata,
        onEditPendingMessage,
        onToggleMessagePin,
        rollbackActionsByMessageId,
        rollbackRanges,
        sessionId,
        toolChromeCommon,
        resolveCreatedAtForMessageId,
        resolveKindForMessageId,
        resolveRollbackActionForMessage,
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
    directControlFooter: ChatListInternalProps['directControlFooter'];
    handleComposerInsetHeightChange: (height: number) => void;
    handleNativeHotTailHeightChange: (height: number) => void;
    isLoadingOlder: boolean;
    mainTranscriptListShellFrame: Parameters<typeof resolveTranscriptListShellEdgeSlots>[0]['frame'];
    onRequestSwitchToRemote: ChatListInternalProps['onRequestSwitchToRemote'];
    olderPaginationIsLoadingOlder: boolean;
    prependRangeReservePx: number;
    renderTranscriptItemAtIndex: (item: ChatTranscriptListItem, index: number) => React.ReactNode;
    sessionId: string;
    shouldUseNativeHotColdSplit: boolean;
    shouldUseWebHotColdSplit: boolean;
    showCatchUpOverlay: boolean;
    showFirstPaintPlaceholder: boolean;
    transcriptHotColdSegments: TranscriptRenderWindowProjection<ChatTranscriptListItem>['hotCold'];
    transcriptOlderLoadSpinnerDelayMs: number;
}>;

export function useTranscriptItemsEdgeSlots(deps: TranscriptItemsEdgeSlotsDeps) {
    const {
        bottomNotice,
        composerInsetHeight,
        controlSwitchTo,
        controlledByUserOverride,
        directControlFooter,
        handleComposerInsetHeightChange,
        handleNativeHotTailHeightChange,
        isLoadingOlder,
        mainTranscriptListShellFrame,
        onRequestSwitchToRemote,
        olderPaginationIsLoadingOlder,
        prependRangeReservePx,
        renderTranscriptItemAtIndex,
        sessionId,
        shouldUseNativeHotColdSplit,
        shouldUseWebHotColdSplit,
        showCatchUpOverlay,
        showFirstPaintPlaceholder,
        transcriptHotColdSegments,
        transcriptOlderLoadSpinnerDelayMs,
    } = deps;
    const listHeaderNode = React.useMemo(() => (
        <ListHeader />
    ), []);
    const listFooterNode = React.useMemo(() => (
        <>
            {prependRangeReservePx > 0 ? (
                <View
                    pointerEvents="none"
                    testID="transcript-web-prepend-range-reserve"
                    style={{ height: prependRangeReservePx }}
                />
            ) : null}
            <ChatListFooterWithKeyboardInset
                sessionId={sessionId}
                bottomNotice={bottomNotice}
                controlledByUserOverride={controlledByUserOverride}
                controlSwitchTo={controlSwitchTo ?? null}
                onRequestSwitchToRemote={onRequestSwitchToRemote}
                directControl={directControlFooter}
                onComposerInsetHeightChange={handleComposerInsetHeightChange}
            />
        </>
    ), [
        bottomNotice,
        controlSwitchTo,
        controlledByUserOverride,
        directControlFooter,
        handleComposerInsetHeightChange,
        onRequestSwitchToRemote,
        prependRangeReservePx,
        sessionId,
    ]);
    const flashListFooterNode = React.useMemo(() => {
        if (shouldUseWebHotColdSplit) {
            return (
                <WebTranscriptSplitFooter
                    hotItems={transcriptHotColdSegments.hotItems}
                    startIndex={transcriptHotColdSegments.coldItems.length}
                    renderItemAtIndex={renderTranscriptItemAtIndex}
                    footer={listFooterNode}
                />
            );
        }
        if (shouldUseNativeHotColdSplit) {
            return (
                <TranscriptHotTail
                    hotItems={transcriptHotColdSegments.hotItemsCanonical}
                    startIndex={Math.max(0, transcriptHotColdSegments.hotCount - 1)}
                    displayIndexMode="invertedEdgeSlot"
                    renderItemAtIndex={renderTranscriptItemAtIndex}
                    footer={listFooterNode}
                    testIDPrefix="transcript-native-hot-tail"
                    onHeightChange={handleNativeHotTailHeightChange}
                />
            );
        }
        return listFooterNode;
    }, [
        handleNativeHotTailHeightChange,
        listFooterNode,
        renderTranscriptItemAtIndex,
        shouldUseNativeHotColdSplit,
        shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotCount,
        transcriptHotColdSegments.hotItems,
        transcriptHotColdSegments.hotItemsCanonical,
    ]);
    const edgeSlots = React.useMemo(() => resolveTranscriptListShellEdgeSlots({
        frame: mainTranscriptListShellFrame,
        visualTopNode: listHeaderNode,
        visualBottomNode: flashListFooterNode,
    }), [flashListFooterNode, listHeaderNode, mainTranscriptListShellFrame]);
    const olderLoadOverlay =
        (olderPaginationIsLoadingOlder || isLoadingOlder) && !showFirstPaintPlaceholder ? (
            <OlderLoadProgressOverlay />
        ) : null;
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
