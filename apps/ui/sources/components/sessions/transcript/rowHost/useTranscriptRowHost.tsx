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
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
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
    listDataRef: Ref<readonly ChatTranscriptListItem[]>;
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
    toolRouteCommonRef: Ref<ChatListInternalProps['toolRouteCommon']>;
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
        listDataRef,
        listOrientation,
        measurementReconciler,
        resolveCreatedAtForMessageId,
        resolveKindForMessageId,
        resolveRollbackActionForMessage,
        resolveThinkingExpanded,
        resolveToolCallMessagesForIds,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        toolRouteCommonRef,
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
        metadata,
        onEditPendingMessage,
        onToggleMessagePin,
        rollbackActionsByMessageId,
        rollbackRanges,
        sessionId,
        toolChromeCommon,
    } = deps.props;
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
            return wrapTranscriptItemForAnchor(item, (
                <TranscriptEnterWrapper id={item.id} createdAt={createdAt}>
                    <PendingMessagesTranscriptBlock
                        sessionId={sessionId}
                        pendingMessages={item.pendingMessages}
                        discardedMessages={item.discardedMessages}
                        onEditPendingMessage={onEditPendingMessage}
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
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'tool-group-header') {
            const interaction = deriveReadOnlyTranscriptInteraction(transcriptInteraction, item.isReadOnlyContext === true);
            const headerToolMessageIds = item.toolMessageIds;
            const headerGroupId = item.groupId;
            return wrapTranscriptItemForAnchor(item, (
                <ToolCallsGroupUnitHeaderRowWithSessionCommon
                    sessionId={sessionId}
                    groupId={item.groupId}
                    metadata={metadata}
                    interaction={interaction}
                    toolMessages={resolveToolCallMessagesForIds(item.toolMessageIds)}
                    expanded={item.expanded}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: headerGroupId,
                        toolMessageIds: headerToolMessageIds,
                        expanded,
                    })}
                    forkCommon={forkCommon}
                    messageDisplayCommon={messageDisplayCommon}
                    toolChromeCommon={toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
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
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ));
        }
        if (item.kind === 'tool-group-tool') {
            const interaction = deriveReadOnlyTranscriptInteraction(transcriptInteraction, item.isReadOnlyContext === true);
            const toolMessage = getMessageById(item.toolMessageId);
            return wrapTranscriptItemForAnchor(item, toolMessage?.kind === 'tool-call' ? (
                <ToolCallsGroupUnitToolRowWithSessionCommon
                    sessionId={sessionId}
                    groupId={item.groupId}
                    metadata={metadata}
                    interaction={interaction}
                    message={toolMessage}
                    expanded={item.expanded}
                    approvalRequests={approvalRequests}
                    messagePins={messagePins}
                    onToggleToolPin={onToggleMessagePin}
                    forkCommon={forkCommon}
                    messageDisplayCommon={messageDisplayCommon}
                    toolChromeCommon={toolChromeCommon}
                    toolRouteCommon={toolRouteCommonRef.current}
                />
            ) : null);
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
                    toolRouteCommon={toolRouteCommonRef.current}
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
                <TranscriptEnterWrapper id={item.id} createdAt={turnCreatedAt}>
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
                        resolveThinkingExpanded={resolveThinkingExpanded}
                        setThinkingExpanded={setThinkingExpanded}
                        expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                        setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                        forkCommon={forkCommon}
                        messageDisplayCommon={messageDisplayCommon}
                        toolChromeCommon={toolChromeCommon}
                        toolRouteCommon={toolRouteCommonRef.current}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'message') {
            const rowActiveThinkingMessageId = resolveTranscriptItemActiveThinkingMessageId(item, activeThinkingMessageId);
            const toolChromeMode = toolTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
            const neighborItems = listDataRef.current[index]?.id === item.id
                ? listDataRef.current
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
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
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
                            approvalRequests={approvalRequests}
                            messagePins={messagePins}
                            onToggleMessagePin={onToggleMessagePin}
                            forkCommon={forkCommon}
                            messageDisplayCommon={messageDisplayCommon}
                            toolChromeCommon={toolChromeCommon}
                            toolRouteCommon={toolRouteCommonRef.current}
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
        listDataRef,
        listOrientation,
        activeThinkingMessageId,
        approvalRequests,
        forkCommon,
        forkedTranscriptEnabled,
        transcriptInteraction,
        messageDisplayCommon,
        messagePins,
        messagesById,
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
        toolRouteCommonRef,
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

