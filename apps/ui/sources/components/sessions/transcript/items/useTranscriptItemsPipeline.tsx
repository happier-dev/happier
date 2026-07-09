import * as React from 'react';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { getStorage } from '@/sync/domains/state/storage';
import type { SessionViewportAnchorSnapshot } from '@/sync/sync';
import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import { buildTranscriptTurnUnits } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import { shouldAutoExpandToolCallsGroupForShortTranscript } from '@/components/sessions/transcript/toolCalls/resolveToolCallsGroupAutoExpandPolicy';
import { resolveTranscriptInitialFillTuning } from '@/components/sessions/transcript/scroll/resolveTranscriptInitialFillTuning';
import {
    useTranscriptJumpTargetWindowActiveBridge,
    useTranscriptJumpWindowFacts,
} from '@/components/sessions/transcript/viewport/jump/host/useTranscriptJumpHost';
import {
    resolveTranscriptRenderWindowProjection,
    type TranscriptRenderWindowProjection,
} from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import type { TranscriptTargetWindowState } from '@/components/sessions/transcript/viewport/window/transcriptTargetWindowTypes';
import {
    resolveTranscriptLiveTailAnchor,
} from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';
import {
    buildTranscriptRowShellSignature,
    resolveTranscriptItemActiveThinkingMessageId,
    resolveTranscriptRowItemType,
} from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import {
    normalizeRestoreAnchorIdentity,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreAnchorUtilities';
import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import type {
    EntryRestoreOwnerAnchor,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type {
    TranscriptViewportAnchorIdentity,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import {
    recordStreamingVisibleUpdateForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    isEnrichedMarkdownRuntimePreloaded,
    preloadEnrichedMarkdownRuntime,
} from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import type { SessionOpenLatchEffect } from '@/components/sessions/transcript/viewport/sessionOpen/types';
import type { EntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';

type Ref<T> = { current: T };

export type TranscriptItemsPipelineDeps = Readonly<{
    activeTargetWindowTargetRef: Ref<any>;
    activeThinkingMessageId: string | null;
    canonicalWindowedItemsRef: Ref<readonly ChatTranscriptListItem[]>;
    committedMessagesCount: number;
    entrySliceWindow: Readonly<{ sessionId: string; anchorRowId: string }> | null;
    entrySliceWindowRef: Ref<{ sessionId: string; anchorRowId: string } | null>;
    entrySliceWithheldCountRef: Ref<number>;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null;
    getMessageById?: (messageId: string) => Message | null;
    getMessageRevisionById?: (messageId: string) => number | null;
    groupingMode: string;
    isLoaded: boolean;
    items: ChatTranscriptListItem[];
    itemsRef: Ref<readonly ChatTranscriptListItem[]>;
    jumpToSeq: number | null | undefined;
    latestCommittedActivityKey: string | null;
    listDataRef: Ref<readonly ChatTranscriptListItem[]>;
    listOrientation: TranscriptListOrientation;
    messagesById: Readonly<Record<string, Message>>;
    nativeHotEdgeVisibleRowsRef: Ref<{
        firstItemId: string | null;
        firstSourceIndex: number | null;
        lastItemId: string | null;
        lastSourceIndex: number | null;
    } | null>;
    platformOS: string;
    preDecompositionItemsRef: Ref<ChatTranscriptListItem[]>;
    renderWindowIndexMapRef: Ref<TranscriptRenderWindowProjection<ChatTranscriptListItem>['indexMap'] | null>;
    resolveThinkingExpanded: (messageId: string) => boolean;
    rowFontScaleKey: string;
    rowWidthBucket: string;
    sessionActive: boolean;
    sessionId: string;
    sessionThinking: boolean;
    setEntrySliceWindow: React.Dispatch<React.SetStateAction<{ sessionId: string; anchorRowId: string } | null>>;
    targetWindowActiveRef: Ref<boolean>;
    targetWindowState?: TranscriptTargetWindowState;
    transcriptNativeHotTailItemCount: number;
    transcriptToolCallsCollapsedPreviewCountSetting: unknown;
    transcriptWebHotTailItemCount: number;
    webHotColdCountsRef: Ref<{ coldCount: number; hotCount: number }>;
}>;

export function useTranscriptItemsPipeline(deps: TranscriptItemsPipelineDeps) {
    const {
        activeTargetWindowTargetRef,
        activeThinkingMessageId,
        canonicalWindowedItemsRef,
        committedMessagesCount,
        entrySliceWindow,
        entrySliceWindowRef,
        entrySliceWithheldCountRef,
        expandedToolCallsAnchorMessageIds,
        forkMessageMetadataById,
        getMessageById: getMessageByIdOverride,
        getMessageRevisionById: getMessageRevisionByIdOverride,
        groupingMode,
        isLoaded,
        items,
        itemsRef,
        jumpToSeq,
        latestCommittedActivityKey,
        listDataRef,
        listOrientation,
        messagesById,
        nativeHotEdgeVisibleRowsRef,
        platformOS,
        preDecompositionItemsRef,
        renderWindowIndexMapRef,
        resolveThinkingExpanded,
        rowFontScaleKey,
        rowWidthBucket,
        sessionActive,
        sessionId,
        sessionThinking,
        setEntrySliceWindow,
        targetWindowActiveRef,
        targetWindowState,
        transcriptNativeHotTailItemCount,
        transcriptToolCallsCollapsedPreviewCountSetting,
        transcriptWebHotTailItemCount,
        webHotColdCountsRef,
    } = deps;

    const getTurnMessageById = React.useCallback((messageId: string): Message | null => {
        if (getMessageByIdOverride) return getMessageByIdOverride(messageId);
        const forkAwareMessage = messagesById[messageId];
        if (forkAwareMessage) return forkAwareMessage;
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[sessionId];
        return session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
    }, [getMessageByIdOverride, messagesById, sessionId]);

    const getTurnMessageRevisionById = React.useCallback((messageId: string): number | null => {
        if (getMessageRevisionByIdOverride) return getMessageRevisionByIdOverride(messageId);
        const state = getStorage().getState();
        const originSessionId = forkMessageMetadataById?.[messageId]?.originSessionId ?? sessionId;
        const revision = state?.sessionMessages?.[originSessionId]?.messageRevisionsById?.[messageId];
        return typeof revision === 'number' && Number.isFinite(revision) ? Math.trunc(revision) : null;
    }, [forkMessageMetadataById, getMessageRevisionByIdOverride, sessionId]);

    const resolveToolCallMessagesForIds = React.useCallback((toolMessageIds: readonly string[]): ToolCallMessage[] => {
        const toolMessages: ToolCallMessage[] = [];
        for (const toolMessageId of toolMessageIds) {
            const message = getTurnMessageById(toolMessageId);
            if (message?.kind === 'tool-call') toolMessages.push(message);
        }
        return toolMessages;
    }, [getTurnMessageById]);

    const decomposedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        return buildTranscriptTurnUnits({
            items,
            getMessageById: getTurnMessageById,
            metadataByMessageId: forkMessageMetadataById ?? undefined,
            isGroupExpanded: (toolMessageIds) => toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id)),
            collapsedPreviewCount: resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting),
        });
    }, [
        expandedToolCallsAnchorMessageIds,
        forkMessageMetadataById,
        getTurnMessageById,
        items,
        transcriptToolCallsCollapsedPreviewCountSetting,
    ]);

    const jumpWindowFacts = useTranscriptJumpWindowFacts({
        getMessageById: getTurnMessageById,
        messagesById,
        sessionId,
    });
    const projectionLiveTailAnchor = React.useMemo(() => resolveTranscriptLiveTailAnchor({
        items: decomposedItems,
        getMessageById: getTurnMessageById,
        thinkingFallbackMessageId: activeThinkingMessageId,
        turnActive: sessionThinking,
        sessionActive,
        latestCommittedActivityKey,
    }), [
        activeThinkingMessageId,
        decomposedItems,
        getTurnMessageById,
        latestCommittedActivityKey,
        sessionActive,
        sessionThinking,
    ]);
    const projectionLiveTailAnchorMessageId = projectionLiveTailAnchor?.messageId ?? null;
    const renderWindowProjection = React.useMemo(() => {
        return resolveTranscriptRenderWindowProjection({
            activeThinkingMessageId,
            entrySliceWindow,
            expandedToolCallsAnchorMessageIds,
            isSeqLoaded: jumpWindowFacts.isSeqLoaded,
            items: decomposedItems,
            liveTailAnchorMessageId: projectionLiveTailAnchorMessageId,
            listOrientation,
            platformOS,
            resolveSeq: jumpWindowFacts.resolveTargetWindowItemSeq,
            sessionId,
            targetWindowState: targetWindowState ?? jumpWindowFacts.sessionTargetWindowState,
            transcriptNativeHotTailItemCount,
            transcriptWebHotTailItemCount,
        });
    }, [
        activeThinkingMessageId,
        decomposedItems,
        entrySliceWindow,
        expandedToolCallsAnchorMessageIds,
        jumpWindowFacts,
        listOrientation,
        platformOS,
        projectionLiveTailAnchorMessageId,
        sessionId,
        targetWindowState,
        transcriptNativeHotTailItemCount,
        transcriptWebHotTailItemCount,
    ]);

    const entrySliceSourceBounds = renderWindowProjection.entrySlice.bounds;
    entrySliceWithheldCountRef.current = renderWindowProjection.entrySlice.withheldCount;
    const targetWindowHostFacts = renderWindowProjection.targetWindow;
    const targetWindowActive = targetWindowHostFacts.targetWindowActive;
    useTranscriptJumpTargetWindowActiveBridge({
        activeTargetWindowTargetRef,
        targetWindowActive,
        targetWindowActiveRef,
    });
    const canonicalWindowedItems = renderWindowProjection.canonicalWindowedItems;
    const displayItems = renderWindowProjection.displayItems;
    const liveTailAnchor = React.useMemo(() => resolveTranscriptLiveTailAnchor({
        items: canonicalWindowedItems,
        getMessageById: getTurnMessageById,
        thinkingFallbackMessageId: activeThinkingMessageId,
        turnActive: sessionThinking,
        sessionActive,
        latestCommittedActivityKey,
    }), [
        activeThinkingMessageId,
        canonicalWindowedItems,
        getTurnMessageById,
        latestCommittedActivityKey,
        sessionActive,
        sessionThinking,
    ]);
    const transcriptHotColdSegments = renderWindowProjection.hotCold;
    const transcriptHotColdSplitActive = transcriptHotColdSegments.active;
    const shouldUseWebHotColdSplit = platformOS === 'web' && transcriptHotColdSplitActive;
    const shouldUseNativeHotColdSplit = platformOS !== 'web' && transcriptHotColdSplitActive;
    const listData = renderWindowProjection.listData;
    webHotColdCountsRef.current = {
        coldCount: transcriptHotColdSplitActive
            ? transcriptHotColdSegments.coldItems.length
            : listData.length,
        hotCount: transcriptHotColdSplitActive
            ? transcriptHotColdSegments.hotItems.length
            : 0,
    };

    React.useEffect(() => {
        if (entrySliceWindow && entrySliceWindow.sessionId !== sessionId) {
            entrySliceWindowRef.current = null;
            setEntrySliceWindow(null);
        }
    }, [entrySliceWindow, entrySliceWindowRef, sessionId, setEntrySliceWindow]);
    React.useEffect(() => {
        if (jumpToSeq == null) return;
        if (entrySliceWindowRef.current?.sessionId !== sessionId) return;
        entrySliceWindowRef.current = null;
        setEntrySliceWindow(null);
    }, [entrySliceWindowRef, jumpToSeq, sessionId, setEntrySliceWindow]);

    canonicalWindowedItemsRef.current = canonicalWindowedItems;
    renderWindowIndexMapRef.current = renderWindowProjection.indexMap;
    nativeHotEdgeVisibleRowsRef.current = renderWindowProjection.hotCold.nativeEdgeSlotItems.length > 0
        ? {
            firstItemId: renderWindowProjection.hotCold.nativeEdgeSlotItems[0]?.id ?? null,
            firstSourceIndex: renderWindowProjection.indexMap.hotEdgeSourceIndices[0] ?? null,
            lastItemId: renderWindowProjection.hotCold.nativeEdgeSlotItems[renderWindowProjection.hotCold.nativeEdgeSlotItems.length - 1]?.id ?? null,
            lastSourceIndex: renderWindowProjection.indexMap.hotEdgeSourceIndices[renderWindowProjection.indexMap.hotEdgeSourceIndices.length - 1] ?? null,
        }
        : null;
    itemsRef.current = displayItems;
    listDataRef.current = listData;
    preDecompositionItemsRef.current = items;
    React.useEffect(() => {
        recordStreamingVisibleUpdateForSessionUiTelemetry({
            sessionId,
            latestMessageId: latestCommittedActivityKey,
            committedMessages: committedMessagesCount,
            transcriptLoaded: isLoaded ? 1 : 0,
            visibleItems: listData.length,
        });
    }, [
        committedMessagesCount,
        isLoaded,
        latestCommittedActivityKey,
        listData.length,
        sessionId,
    ]);

    const resolveCreatedAtForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const createdAt = message?.createdAt;
        return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null;
    }, [sessionId]);

    const resolveSeqForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const seq = message?.seq;
        return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
    }, [sessionId]);

    const resolveRestoreAnchorIdentityFromSourceIndex = React.useCallback((index: number): TranscriptViewportAnchorIdentity | null => {
        if (!Number.isFinite(index)) return null;
        const item = itemsRef.current[Math.max(0, Math.trunc(index))] as ChatTranscriptListItem | undefined;
        return item ? resolveTranscriptViewportAnchorDescriptor(item) : null;
    }, [itemsRef]);

    const resolveRestoreAnchorSourceIndexFromLoadedItems = React.useCallback((anchor: TranscriptViewportAnchorIdentity): number | null => {
        return resolveTranscriptViewportAnchorIndex({
            anchor,
            items: itemsRef.current,
        });
    }, [itemsRef]);

    const resolveKindForMessageId = React.useCallback((messageId: string): string | null => {
        const state = getStorage().getState();
        const session = state?.sessionMessages?.[sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const kind = message?.kind;
        return typeof kind === 'string' ? kind : null;
    }, [sessionId]);

    const keyExtractor = React.useCallback((item: ChatTranscriptListItem) => item.id, []);
    const getItemType = React.useCallback((item: ChatTranscriptListItem): string => (
        resolveTranscriptRowItemType({
            activeThinkingMessageId: resolveTranscriptItemActiveThinkingMessageId(item, activeThinkingMessageId),
            getMessageById: getTurnMessageById,
            item,
        })
    ), [activeThinkingMessageId, getTurnMessageById]);

    const buildRowShellSignature = React.useCallback((item: ChatTranscriptListItem) => (
        buildTranscriptRowShellSignature({
            activeThinkingMessageId: resolveTranscriptItemActiveThinkingMessageId(item, activeThinkingMessageId),
            expandedToolCallsAnchorMessageIds,
            forkMessageMetadataById,
            getMessageById: getTurnMessageById,
            getMessageRevisionById: getTurnMessageRevisionById,
            groupingMode,
            item,
            latestCommittedActivityKey,
            resolveThinkingExpanded,
            sessionActive,
            widthBucket: rowWidthBucket,
            fontScaleKey: rowFontScaleKey,
        })
    ), [
        activeThinkingMessageId,
        expandedToolCallsAnchorMessageIds,
        forkMessageMetadataById,
        getTurnMessageById,
        getTurnMessageRevisionById,
        groupingMode,
        latestCommittedActivityKey,
        resolveThinkingExpanded,
        rowFontScaleKey,
        rowWidthBucket,
        sessionActive,
    ]);

    const resolveSeqForViewportAnchor = React.useCallback((anchor: SessionViewportAnchorSnapshot): number | null => {
        const anchorMessageId = typeof anchor.messageId === 'string' && anchor.messageId.length > 0
            ? anchor.messageId
            : null;
        const messageSeq = anchorMessageId ? resolveSeqForMessageId(anchorMessageId) : null;
        const normalizeSeq = (value: unknown): number | null => {
            if (typeof value !== 'number' || !Number.isFinite(value)) return null;
            const seq = Math.trunc(value);
            return seq > 0 ? seq : null;
        };
        return normalizeSeq(messageSeq) ?? normalizeSeq(anchor.seq);
    }, [resolveSeqForMessageId]);

    const resolveViewportItemSeqs = React.useCallback((item: ChatTranscriptListItem): number[] => {
        const seqs: number[] = [];
        const addSeq = (seq: number | null | undefined) => {
            if (typeof seq === 'number' && Number.isFinite(seq)) seqs.push(Math.trunc(seq));
        };
        if (item.kind === 'message') {
            addSeq(item.seq ?? resolveSeqForMessageId(item.messageId));
            return seqs;
        }
        if (item.kind === 'tool-calls-group') {
            for (const toolMessageId of item.toolMessageIds) {
                addSeq(resolveSeqForMessageId(toolMessageId));
            }
            return seqs;
        }
        if (item.kind === 'tool-group-tool') {
            addSeq(item.seq ?? resolveSeqForMessageId(item.toolMessageId));
            return seqs;
        }
        if (item.kind === 'turn') {
            if (item.turn.userMessageId) {
                addSeq(resolveSeqForMessageId(item.turn.userMessageId));
            }
            for (const content of item.turn.content) {
                if (content.kind === 'message') {
                    addSeq(resolveSeqForMessageId(content.messageId));
                } else if (content.kind === 'tool_calls') {
                    for (const toolMessageId of content.toolMessageIds) {
                        addSeq(resolveSeqForMessageId(toolMessageId));
                    }
                }
            }
        }
        return seqs;
    }, [resolveSeqForMessageId]);

    const resolveNearestSurvivingViewportAnchorIndexFromItems = React.useCallback((
        anchor: SessionViewportAnchorSnapshot,
        sourceItems: readonly ChatTranscriptListItem[],
    ): number | null => {
        const anchorSeq = resolveSeqForViewportAnchor(anchor);
        if (anchorSeq == null) return null;
        type AnchorIndexCandidate = { index: number; seq: number };
        let earlier: AnchorIndexCandidate | null = null;
        let later: AnchorIndexCandidate | null = null;
        for (let index = 0; index < sourceItems.length; index += 1) {
            const item = sourceItems[index]!;
            for (const normalizedSeq of resolveViewportItemSeqs(item)) {
                if (normalizedSeq < anchorSeq) {
                    if (!earlier || normalizedSeq > earlier.seq) earlier = { index, seq: normalizedSeq };
                    continue;
                }
                if (normalizedSeq > anchorSeq) {
                    if (!later || normalizedSeq < later.seq) later = { index, seq: normalizedSeq };
                }
            }
        }
        return earlier?.index ?? later?.index ?? null;
    }, [resolveSeqForViewportAnchor, resolveViewportItemSeqs]);

    const resolveNearestSurvivingViewportAnchorIndex = React.useCallback((anchor: SessionViewportAnchorSnapshot): number | null => {
        return resolveNearestSurvivingViewportAnchorIndexFromItems(anchor, listDataRef.current);
    }, [listDataRef, resolveNearestSurvivingViewportAnchorIndexFromItems]);

    const isViewportAnchorSeqLoaded = React.useCallback((anchorSeq: number, sourceItems: readonly ChatTranscriptListItem[]): boolean => {
        const normalizedAnchorSeq = Math.trunc(anchorSeq);
        for (const item of sourceItems) {
            if (resolveViewportItemSeqs(item).some((seq) => seq === normalizedAnchorSeq)) return true;
        }
        return false;
    }, [resolveViewportItemSeqs]);

    const resolveEntryRestoreOwnerAnchor = React.useCallback((
        anchor: SessionViewportAnchorSnapshot,
        resolvedIndex: number | null,
        sourceItems: readonly ChatTranscriptListItem[],
    ): EntryRestoreOwnerAnchor | null => {
        const resolvedItem = resolvedIndex != null
            ? sourceItems[Math.max(0, Math.trunc(resolvedIndex))]
            : undefined;
        const currentIdentity = resolvedItem
            ? resolveTranscriptViewportAnchorDescriptor(resolvedItem)
            : null;
        const fallbackIdentity = normalizeRestoreAnchorIdentity(anchor);
        const identity = currentIdentity ?? fallbackIdentity;
        if (!identity) return null;
        return {
            ...identity,
            capturedAtMs: anchor.capturedAtMs,
            itemOffsetPx: anchor.itemOffsetPx,
            seq: resolveSeqForViewportAnchor(anchor),
        };
    }, [resolveSeqForViewportAnchor]);

    return React.useMemo(() => ({
        buildRowShellSignature,
        canonicalWindowedItems,
        decomposedItems,
        displayItems,
        entrySliceSourceBounds,
        getItemType,
        getTurnMessageById,
        getTurnMessageRevisionById,
        isViewportAnchorSeqLoaded,
        keyExtractor,
        listData,
        liveTailAnchor,
        renderWindowProjection,
        resolveCreatedAtForMessageId,
        resolveEntryRestoreOwnerAnchor,
        resolveKindForMessageId,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveNearestSurvivingViewportAnchorIndexFromItems,
        resolveRestoreAnchorIdentityFromSourceIndex,
        resolveRestoreAnchorSourceIndexFromLoadedItems,
        resolveSeqForMessageId,
        resolveSeqForViewportAnchor,
        resolveTargetWindowItemSeq: jumpWindowFacts.resolveTargetWindowItemSeq,
        resolveToolCallMessagesForIds,
        shouldUseNativeHotColdSplit,
        shouldUseWebHotColdSplit,
        targetWindowActive,
        targetWindowHostFacts,
        transcriptHotColdSegments,
    }), [
        buildRowShellSignature,
        canonicalWindowedItems,
        decomposedItems,
        displayItems,
        entrySliceSourceBounds,
        getItemType,
        getTurnMessageById,
        getTurnMessageRevisionById,
        isViewportAnchorSeqLoaded,
        keyExtractor,
        listData,
        liveTailAnchor,
        renderWindowProjection,
        resolveCreatedAtForMessageId,
        resolveEntryRestoreOwnerAnchor,
        resolveKindForMessageId,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveNearestSurvivingViewportAnchorIndexFromItems,
        resolveRestoreAnchorIdentityFromSourceIndex,
        resolveRestoreAnchorSourceIndexFromLoadedItems,
        resolveSeqForMessageId,
        resolveSeqForViewportAnchor,
        resolveToolCallMessagesForIds,
        shouldUseNativeHotColdSplit,
        shouldUseWebHotColdSplit,
        targetWindowActive,
        targetWindowHostFacts,
        transcriptHotColdSegments,
        jumpWindowFacts.resolveTargetWindowItemSeq,
    ]);
}

type ToolCallsGroupExpansionRequest = Readonly<{
    expanded: boolean;
    toolCallsGroupId: string;
    toolMessageIds: readonly string[];
}>;

export type TranscriptToolAutoExpandEffectDeps = Readonly<{
    applyToolCallsGroupExpanded: (request: ToolCallsGroupExpansionRequest) => void;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    hasAutoExpandedToolCallsGroups: (sessionId: string) => boolean;
    isScrollable: () => boolean;
    jumpToSeq: number | null | undefined;
    markAutoExpandedToolCallsGroups: (sessionId: string) => void;
    maxTurnEntriesPerListItem: number;
    pinToBottom: (reason: 'content-size-change') => unknown;
    preDecompositionItemsRef: Ref<readonly ChatTranscriptListItem[]>;
    sessionEntryViewportRef: Ref<{ shouldFollowBottom?: boolean | null } | null>;
    sessionId: string;
    transcriptToolCallsCollapsedPreviewCountSetting: unknown;
}>;

export function useTranscriptToolAutoExpandEffect(deps: TranscriptToolAutoExpandEffectDeps): void {
    const {
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        hasAutoExpandedToolCallsGroups,
        isScrollable,
        jumpToSeq,
        markAutoExpandedToolCallsGroups,
        maxTurnEntriesPerListItem,
        pinToBottom,
        preDecompositionItemsRef,
        sessionEntryViewportRef,
        sessionId,
        transcriptToolCallsCollapsedPreviewCountSetting,
    } = deps;
    const resolveToolCallsCollapsedPreviewCount = React.useCallback((): number => {
        return resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting);
    }, [transcriptToolCallsCollapsedPreviewCountSetting]);
    const tryAutoExpandNewestToolCallsGroup = React.useCallback((): boolean => {
        const previewCount = resolveToolCallsCollapsedPreviewCount();
        const items = preDecompositionItemsRef.current;
        const shouldAutoExpandGroup = (toolMessageIds: readonly string[]): boolean => (
            shouldAutoExpandToolCallsGroupForShortTranscript({
                toolMessageCount: toolMessageIds.length,
                collapsedPreviewCount: previewCount,
                maxTurnEntriesPerListItem,
            })
        );
        const visitItem = (it: ChatTranscriptListItem | null | undefined): boolean => {
            if (!it) return false;
            if (it.kind === 'tool-calls-group') {
                const toolMessageIds = it.toolMessageIds;
                if (!shouldAutoExpandGroup(toolMessageIds)) return false;
                if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) return false;
                applyToolCallsGroupExpanded({ toolCallsGroupId: it.id, toolMessageIds, expanded: true });
                return true;
            }
            if (it.kind === 'turn') {
                const content = it.turn?.content;
                if (!Array.isArray(content) || content.length === 0) return false;
                for (let j = content.length - 1; j >= 0; j -= 1) {
                    const c = content[j];
                    if (c.kind !== 'tool_calls') continue;
                    const toolMessageIds = c.toolMessageIds;
                    if (!shouldAutoExpandGroup(toolMessageIds)) continue;
                    if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) continue;
                    applyToolCallsGroupExpanded({ toolCallsGroupId: c.id, toolMessageIds, expanded: true });
                    return true;
                }
            }
            return false;
        };
        for (let i = items.length - 1; i >= 0; i -= 1) {
            if (visitItem(items[i])) return true;
        }
        return false;
    }, [
        applyToolCallsGroupExpanded,
        expandedToolCallsAnchorMessageIds,
        maxTurnEntriesPerListItem,
        preDecompositionItemsRef,
        resolveToolCallsCollapsedPreviewCount,
    ]);

    React.useEffect(() => {
        if (jumpToSeq != null) return;
        if (!sessionId) return;
        if (hasAutoExpandedToolCallsGroups(sessionId)) return;
        if (isScrollable()) return;
        const expanded = tryAutoExpandNewestToolCallsGroup();
        if (!expanded) return;
        markAutoExpandedToolCallsGroups(sessionId);
        fireAndForget((async () => {
            await Promise.resolve();
            await Promise.resolve();
            if (sessionEntryViewportRef.current?.shouldFollowBottom === false) return;
            pinToBottom('content-size-change');
        })(), { tag: 'ChatList.autoExpandToolCallsGroup' });
    });
}

export type TranscriptEntrySliceRevealDeps = Readonly<{
    armNativeCommit: (budgetMs: number) => void;
    beginNativeTransaction: () => boolean;
    entrySliceWindowRef: Ref<{ sessionId: string; anchorRowId: string } | null>;
    entrySliceWithheldCountRef: Ref<number>;
    sessionId: string;
    setEntrySliceWindow: React.Dispatch<React.SetStateAction<{ sessionId: string; anchorRowId: string } | null>>;
    transcriptInitialFillBudgetMs: number | undefined;
    transcriptInitialFillMaxNoProgressLoads: number | undefined;
}>;

export function useTranscriptEntrySliceReveal(deps: TranscriptEntrySliceRevealDeps): () => number {
    const {
        armNativeCommit,
        beginNativeTransaction,
        entrySliceWindowRef,
        entrySliceWithheldCountRef,
        sessionId,
        setEntrySliceWindow,
        transcriptInitialFillBudgetMs,
        transcriptInitialFillMaxNoProgressLoads,
    } = deps;
    return React.useCallback((): number => {
        const sliceWindow = entrySliceWindowRef.current;
        if (!sliceWindow || sliceWindow.sessionId !== sessionId) return 0;
        const withheldCount = entrySliceWithheldCountRef.current;
        if (withheldCount <= 0) {
            entrySliceWindowRef.current = null;
            setEntrySliceWindow(null);
            return 0;
        }
        entrySliceWindowRef.current = null;
        setEntrySliceWindow(null);
        if (beginNativeTransaction()) {
            const { budgetMs } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads,
            });
            armNativeCommit(budgetMs);
        }
        return withheldCount;
    }, [
        armNativeCommit,
        beginNativeTransaction,
        entrySliceWindowRef,
        entrySliceWithheldCountRef,
        sessionId,
        setEntrySliceWindow,
        transcriptInitialFillBudgetMs,
        transcriptInitialFillMaxNoProgressLoads,
    ]);
}

export type TranscriptFirstPaintStateDeps = Readonly<{
    applySessionOpenLatchEffectsRef: Ref<(effects: readonly SessionOpenLatchEffect[]) => void>;
    currentSessionIdRef: Ref<string>;
    entryRestoreOwner: EntryRestoreOwner;
    firstListPaintObserved: boolean;
    isLoaded: boolean;
    isWarmKeepAliveInstance: boolean;
    itemCount: number;
    jumpToSeqActive: boolean;
    lastPinOffsetForIntentRef: Ref<number | null>;
    nativeEntryRestorePaintReleased: boolean;
    nativeFirstPaintFallbackReleaseTimeoutRef: Ref<{ sessionId: string; timeoutId: ReturnType<typeof setTimeout> } | null>;
    nativeInitialViewportPendingObservation: boolean;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleStable: boolean;
    nativeViewportPaintObserved: boolean;
    nativeViewportPaintObservedRef: Ref<boolean>;
    pinThresholdPx: number;
    platformOS: string;
    routeHydrationPending: boolean;
    sessionId: string;
    sessionOpenLatch: SessionOpenLatch;
    transcriptInitialFillBudgetMs: number;
    transcriptMountSettleQuiescentWindowMs: number;
    usesNativeFlashListBottomMaintenance: boolean;
}>;

export function useTranscriptFirstPaintState(deps: TranscriptFirstPaintStateDeps) {
    const {
        applySessionOpenLatchEffectsRef,
        currentSessionIdRef,
        entryRestoreOwner,
        firstListPaintObserved,
        isLoaded,
        isWarmKeepAliveInstance,
        itemCount,
        jumpToSeqActive,
        lastPinOffsetForIntentRef,
        nativeEntryRestorePaintReleased,
        nativeFirstPaintFallbackReleaseTimeoutRef,
        nativeInitialViewportPendingObservation,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        nativeViewportPaintObserved,
        nativeViewportPaintObservedRef,
        pinThresholdPx,
        platformOS,
        routeHydrationPending,
        sessionId,
        sessionOpenLatch,
        transcriptInitialFillBudgetMs,
        transcriptMountSettleQuiescentWindowMs,
        usesNativeFlashListBottomMaintenance,
    } = deps;
    const [webMarkdownRuntimeReady, setWebMarkdownRuntimeReady] = React.useState(isEnrichedMarkdownRuntimePreloaded);
    React.useEffect(() => {
        if (platformOS !== 'web') return undefined;
        if (isEnrichedMarkdownRuntimePreloaded()) {
            setWebMarkdownRuntimeReady(true);
            return undefined;
        }
        let cancelled = false;
        const preload = preloadEnrichedMarkdownRuntime();
        fireAndForget(preload, { tag: 'ChatList.webMarkdownRuntimeFirstPaint' });
        preload.then(
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
            () => {
                if (!cancelled) setWebMarkdownRuntimeReady(true);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [platformOS]);
    const showNativeFirstPaintPlaceholder =
        platformOS !== 'web' &&
        sessionOpenLatch.shouldShowNativeFirstPaintPlaceholder({
            firstListPaintObserved,
            hasOpenEntryRestoreTransaction: entryRestoreOwner.hasOpenTransaction(sessionId),
            isLoaded,
            isWarmKeepAliveInstance,
            itemCount,
            jumpToSeqActive,
            lastPinOffsetForIntent: lastPinOffsetForIntentRef.current,
            nativeEntryRestorePaintReleased,
            nativeInitialViewportPendingObservation,
            nativeMountSettleDeadlineReached,
            nativeMountSettleStable,
            nativeViewportPaintObserved,
            pinThresholdPx,
            sessionId,
            usesNativeFlashListBottomMaintenance,
        });
    const showWebMarkdownRuntimeFirstPaintPlaceholder =
        platformOS === 'web' &&
        isLoaded &&
        itemCount > 0 &&
        !firstListPaintObserved &&
        !webMarkdownRuntimeReady;
    const showRouteHydrationFirstPaintPlaceholder =
        routeHydrationPending &&
        isLoaded &&
        itemCount > 0;
    const showFirstPaintPlaceholder =
        showNativeFirstPaintPlaceholder ||
        showWebMarkdownRuntimeFirstPaintPlaceholder ||
        showRouteHydrationFirstPaintPlaceholder;
    const nativeFirstPaintReleasedWithoutListLoad =
        platformOS !== 'web' &&
        (nativeMountSettleStable || nativeMountSettleDeadlineReached);

    React.useEffect(() => {
        if (platformOS === 'web') return;
        if (!usesNativeFlashListBottomMaintenance) return;
        if (!isLoaded) return;
        if (itemCount <= 0) return;
        if (nativeViewportPaintObservedRef.current) return;
        if (nativeFirstPaintFallbackReleaseTimeoutRef.current?.sessionId === sessionId) return;
        const timeoutMs =
            transcriptInitialFillBudgetMs +
            transcriptMountSettleQuiescentWindowMs * 2 +
            1;
        const handle = {
            sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (nativeFirstPaintFallbackReleaseTimeoutRef.current !== handle) return;
            nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (nativeViewportPaintObservedRef.current) return;
            const decision = sessionOpenLatch.onNativeFirstPaintFallbackDeadline({
                nativeViewportPaintObserved: nativeViewportPaintObservedRef.current,
                nowMs: Date.now(),
                sessionId: handle.sessionId,
            });
            applySessionOpenLatchEffectsRef.current(decision.effects);
        }, timeoutMs);
        nativeFirstPaintFallbackReleaseTimeoutRef.current = handle;
    }, [
        applySessionOpenLatchEffectsRef,
        currentSessionIdRef,
        isLoaded,
        itemCount,
        nativeFirstPaintFallbackReleaseTimeoutRef,
        nativeViewportPaintObservedRef,
        platformOS,
        sessionId,
        sessionOpenLatch,
        transcriptInitialFillBudgetMs,
        transcriptMountSettleQuiescentWindowMs,
        usesNativeFlashListBottomMaintenance,
    ]);

    return {
        nativeFirstPaintReleasedWithoutListLoad,
        showFirstPaintPlaceholder,
        showRouteHydrationFirstPaintPlaceholder,
    };
}
