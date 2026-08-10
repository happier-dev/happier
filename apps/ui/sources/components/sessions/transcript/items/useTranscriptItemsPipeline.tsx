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
    type TranscriptRendererDataTarget,
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
    useEnrichedMarkdownRuntimeStatus,
} from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import {
    resolveTranscriptFirstPaintFallbackDelayMs,
    resolveTranscriptFirstPaintPresentation,
} from '@/components/sessions/transcript/paint/transcriptFirstPaintPresentation';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import type { SessionOpenLatchEffect } from '@/components/sessions/transcript/viewport/sessionOpen/types';
import type { EntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type { TranscriptRendererEntryPlacementEvent } from '@/components/sessions/transcript/viewport/shell/renderer/types';
import {
    createEntryPresentationKey,
    createEntryPresentationState,
    reduceEntryPresentationState,
    type EntryPresentationPlatform,
} from '@/components/sessions/transcript/viewport/entryRestore/entryPresentation';
import { useCommittedTranscriptProjectionSnapshot } from '@/components/sessions/transcript/items/useCommittedTranscriptProjectionSnapshot';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import { createTranscriptWindowGapItem } from '@/components/sessions/transcript/viewport/window/transcriptWindowGapItem';

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
    platformOS: string;
    preDecompositionItemsRef: Ref<ChatTranscriptListItem[]>;
    rendererKind: 'flashList' | 'legendList';
    renderWindowIndexMapRef: Ref<TranscriptRenderWindowProjection<ChatTranscriptListItem>['indexMap'] | null>;
    resolveThinkingExpanded: (messageId: string) => boolean;
    rowFontScaleKey: string;
    rowWidthBucket: string;
    sessionActive: boolean;
    sessionId: string;
    sessionThinking: boolean;
    setEntrySliceWindow: React.Dispatch<React.SetStateAction<{ sessionId: string; anchorRowId: string } | null>>;
    tailContiguousFloorSeq?: number | null;
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
        platformOS,
        preDecompositionItemsRef,
        rendererKind,
        renderWindowIndexMapRef,
        resolveThinkingExpanded,
        rowFontScaleKey,
        rowWidthBucket,
        sessionActive,
        sessionId,
        sessionThinking,
        setEntrySliceWindow,
        tailContiguousFloorSeq,
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
            // Window gaps are projection output, never turn-decomposition input.
            items: items.filter((item) => item.kind !== 'transcript-window-gap'),
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
        forkMessageMetadataById,
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
            createWindowGapItem: createTranscriptWindowGapItem,
            entrySliceWindow,
            expandedToolCallsAnchorMessageIds,
            isSeqLoaded: jumpWindowFacts.isSeqLoaded,
            isSeqRangeLoaded: jumpWindowFacts.isSeqRangeLoaded,
            items: decomposedItems,
            liveTailAnchorMessageId: projectionLiveTailAnchorMessageId,
            listOrientation,
            platformOS,
            rendererKind,
            resolveSeq: jumpWindowFacts.resolveTargetWindowItemSeq,
            sessionId,
            tailContiguousFloorSeq: tailContiguousFloorSeq ?? null,
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
        rendererKind,
        projectionLiveTailAnchorMessageId,
        sessionId,
        tailContiguousFloorSeq,
        targetWindowState,
        transcriptNativeHotTailItemCount,
        transcriptWebHotTailItemCount,
    ]);

    const entrySliceSourceBounds = renderWindowProjection.entrySlice.bounds;
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
    const webHotColdCounts = {
        coldCount: transcriptHotColdSplitActive
            ? transcriptHotColdSegments.coldItems.length
            : listData.length,
        hotCount: transcriptHotColdSplitActive
            ? transcriptHotColdSegments.hotItems.length
            : 0,
    };
    useCommittedTranscriptRef(webHotColdCountsRef, webHotColdCounts);

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

    const nativeHotEdgeVisibleRows = React.useMemo(() => (
        renderWindowProjection.hotCold.nativeEdgeSlotItems.length > 0
            ? {
                firstItemId: renderWindowProjection.hotCold.nativeEdgeSlotItems[0]?.id ?? null,
                firstSourceIndex: renderWindowProjection.indexMap.hotEdgeSourceIndices[0] ?? null,
                lastItemId: renderWindowProjection.hotCold.nativeEdgeSlotItems[renderWindowProjection.hotCold.nativeEdgeSlotItems.length - 1]?.id ?? null,
                lastSourceIndex: renderWindowProjection.indexMap.hotEdgeSourceIndices[renderWindowProjection.indexMap.hotEdgeSourceIndices.length - 1] ?? null,
            }
            : null
    ), [
        renderWindowProjection.hotCold.nativeEdgeSlotItems,
        renderWindowProjection.indexMap.hotEdgeSourceIndices,
    ]);
    useCommittedTranscriptProjectionSnapshot({
        canonicalWindowedItems,
        canonicalWindowedItemsRef,
        displayItems,
        entrySliceWithheldCount: renderWindowProjection.entrySlice.withheldCount,
        entrySliceWithheldCountRef,
        itemsRef,
        listData,
        listDataRef,
        renderWindowIndexMap: renderWindowProjection.indexMap,
        renderWindowIndexMapRef,
    });
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

    const resolveRestoreAnchorRendererTargetFromLoadedItems = React.useCallback((
        anchor: TranscriptViewportAnchorIdentity,
    ): TranscriptRendererDataTarget | null => {
        const displayIndex = resolveTranscriptViewportAnchorIndex({
            anchor,
            items: itemsRef.current,
        });
        return displayIndex == null
            ? null
            : renderWindowIndexMapRef.current?.resolveRendererTargetForDisplayIndex(displayIndex) ?? null;
    }, [itemsRef, renderWindowIndexMapRef]);

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
        nativeHotEdgeVisibleRows,
        renderWindowProjection,
        resolveCreatedAtForMessageId,
        resolveEntryRestoreOwnerAnchor,
        resolveKindForMessageId,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveNearestSurvivingViewportAnchorIndexFromItems,
        resolveRestoreAnchorIdentityFromSourceIndex,
        resolveRestoreAnchorRendererTargetFromLoadedItems,
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
        nativeHotEdgeVisibleRows,
        renderWindowProjection,
        resolveCreatedAtForMessageId,
        resolveEntryRestoreOwnerAnchor,
        resolveKindForMessageId,
        resolveNearestSurvivingViewportAnchorIndex,
        resolveNearestSurvivingViewportAnchorIndexFromItems,
        resolveRestoreAnchorIdentityFromSourceIndex,
        resolveRestoreAnchorRendererTargetFromLoadedItems,
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
    entryAnchorForRender: SessionViewportAnchorSnapshot | null;
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
    rendererKind: 'flashList' | 'legendList';
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
        entryAnchorForRender,
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
        rendererKind,
        routeHydrationPending,
        sessionId,
        sessionOpenLatch,
        transcriptInitialFillBudgetMs,
        transcriptMountSettleQuiescentWindowMs,
        usesNativeFlashListBottomMaintenance,
    } = deps;
    const entryPresentationPlatform: EntryPresentationPlatform | null =
        platformOS === 'web'
            ? 'web'
            : platformOS === 'ios' || platformOS === 'android'
                ? 'native'
                : null;
    const entryPresentationKey =
        entryPresentationPlatform != null &&
        rendererKind === 'legendList' &&
        !jumpToSeqActive &&
        entryAnchorForRender != null
            ? createEntryPresentationKey({
                platform: entryPresentationPlatform,
                sessionId,
            })
            : null;
    const currentEntryPresentationKeyRef = React.useRef(entryPresentationKey);
    currentEntryPresentationKeyRef.current = entryPresentationKey;
    const [entryPresentationState, setEntryPresentationState] = React.useState(
        () => createEntryPresentationState(entryPresentationKey),
    );
    const transitionEntryPresentation = React.useCallback((
        event: Parameters<typeof reduceEntryPresentationState>[1],
    ) => {
        setEntryPresentationState((previous) => {
            const currentKey = currentEntryPresentationKeyRef.current;
            const current = previous.key === currentKey
                ? previous
                : createEntryPresentationState(currentKey);
            return reduceEntryPresentationState(current, event);
        });
    }, []);
    const onEntryPlacementEvent = React.useCallback((
        event: TranscriptRendererEntryPlacementEvent,
    ) => {
        const currentKey = currentEntryPresentationKeyRef.current;
        if (currentKey !== createEntryPresentationKey({
            platform: event.platform,
            sessionId: event.dataKey,
        })) return;
        if (event.type === 'started') {
            transitionEntryPresentation({ type: 'renderer-started' });
            return;
        }
        transitionEntryPresentation({
            type: event.outcome === 'settled'
                ? 'renderer-settled'
                : 'renderer-fallback',
        });
    }, [transitionEntryPresentation]);
    const recordEntryOwnerOutcome = React.useCallback((params: Readonly<{
        outcome: 'confirmed' | 'fallback';
        sessionId: string;
    }>) => {
        const currentKey = currentEntryPresentationKeyRef.current;
        if (
            currentKey == null
            || entryPresentationPlatform == null
            || currentKey !== createEntryPresentationKey({
                platform: entryPresentationPlatform,
                sessionId: params.sessionId,
            })
        ) return;
        transitionEntryPresentation({
            type: params.outcome === 'confirmed'
                ? 'entry-confirmed'
                : 'entry-fallback',
        });
    }, [entryPresentationPlatform, transitionEntryPresentation]);
    const effectiveEntryPresentationState =
        entryPresentationState.key === entryPresentationKey
            ? entryPresentationState
            : createEntryPresentationState(entryPresentationKey);
    const entryPlacementPending =
        entryPresentationKey != null &&
        !effectiveEntryPresentationState.released;
    const webMarkdownRuntimeStatus = useEnrichedMarkdownRuntimeStatus();
    const nativePlacementPending =
        entryPresentationKey == null &&
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
    const [firstPaintDeadlineElapsedSessionId, setFirstPaintDeadlineElapsedSessionId] =
        React.useState<string | null>(null);
    // The web bottom-entry landing has no cover fact of its own. It could only hold the frames
    // `firstListPaintPending` already holds: the policy reveals on this entry's own painted rows
    // (`firstListPaintObserved && itemCount > 0`) ahead of any landing hold, and before that paint
    // the same web+Legend configuration that would arm the hold has `firstListPaintPending` true,
    // so the cover is identical frame for frame and only its reason label could differ.
    // Whether this entry has already had painted rows revealed on screen. Every remaining cover
    // fact needs `isLoaded`, so on a warm/SWR open they all arm one or more renders AFTER the
    // cached rows painted and this policy uncovered them; without this record they would put the
    // placeholder back over content the reader is looking at. It is written only from a committed
    // render, so a superseded intermediate render cannot claim a reveal the reader never saw; that
    // is what keeps a native cold open covered while its rows paint at A and the entry placement
    // moves them to B.
    //
    // It is scoped to the session ENTRY, exactly like every other entry fact here: the session id
    // changing drops it, and so does an entry re-arm on an unchanged session id — jump -> return,
    // bottom <-> anchored — through `resetFirstPaintRevealRecordForSessionEntry`, the member this
    // record contributes to the entry-reset family that also clears the native reveal facts. Each
    // drop bumps a generation, so a commit that observed the PREVIOUS entry's reveal cannot write
    // it back after the reset (the entry re-arm runs in a layout effect, ahead of this record's
    // own passive write for that same commit).
    const revealedPaintedContentRef = React.useRef<Readonly<{
        generation: number;
        revealed: boolean;
        sessionId: string;
    }>>({ generation: 0, revealed: false, sessionId });
    if (revealedPaintedContentRef.current.sessionId !== sessionId) {
        revealedPaintedContentRef.current = {
            generation: revealedPaintedContentRef.current.generation + 1,
            revealed: false,
            sessionId,
        };
    }
    const resetFirstPaintRevealRecordForSessionEntry = React.useCallback(() => {
        revealedPaintedContentRef.current = {
            generation: revealedPaintedContentRef.current.generation + 1,
            revealed: false,
            sessionId: revealedPaintedContentRef.current.sessionId,
        };
    }, []);
    const renderedRevealRecordGeneration = revealedPaintedContentRef.current.generation;
    const presentation = resolveTranscriptFirstPaintPresentation({
        deadlineElapsed: firstPaintDeadlineElapsedSessionId === sessionId,
        // Two placements, two owners, two readiness sources — mutually exclusive by construction
        // above. The keyed join is released by its own owner-plus-renderer outcome and outranks
        // the paint it places; the bottom-entry landing is released by the renderer confirmation
        // or, sooner, by the rows it only settles having painted.
        entryPlacementPending,
        firstListPaintObserved,
        // Only the web Legend renderer reports an onLoad first-paint fact; the other
        // configurations have no such fact and must not be held waiting for one.
        firstListPaintPending:
            platformOS === 'web' &&
            rendererKind === 'legendList' &&
            !firstListPaintObserved,
        isLoaded,
        itemCount,
        // Both remaining data-availability facts only describe rows the transcript already
        // has: with nothing loaded there is no enriched Markdown to wait for and no cached
        // content a route refresh could be covering.
        markdownRuntimePending:
            platformOS === 'web' &&
            isLoaded &&
            itemCount > 0 &&
            webMarkdownRuntimeStatus === 'pending',
        nativePlacementPending,
        paintedContentRevealed: revealedPaintedContentRef.current.revealed,
        routeHydrationPending: routeHydrationPending && isLoaded && itemCount > 0,
    });
    // A reveal only counts once the list has reported its paint and rows exist: that is the
    // evidence the reader can actually see transcript content rather than an empty viewport.
    const revealedPaintedContent =
        !presentation.covered && firstListPaintObserved && itemCount > 0;
    // Deliberately unconditioned: an entry reset can drop the record while `revealedPaintedContent`
    // and the session id both stay unchanged, and a dependency-gated effect would then never write
    // the new entry's own reveal back. The generation check makes the write belong to the entry the
    // render observed, so a commit superseded by a reset cannot restore a stale reveal.
    React.useEffect(() => {
        if (!revealedPaintedContent) return;
        const record = revealedPaintedContentRef.current;
        if (record.revealed || record.generation !== renderedRevealRecordGeneration) return;
        revealedPaintedContentRef.current = { ...record, revealed: true };
    });
    const showFirstPaintPlaceholder = presentation.covered;
    const showRouteHydrationFirstPaintPlaceholder =
        presentation.covered && presentation.reason === 'route-hydration';
    const nativeFirstPaintReleasedWithoutListLoad =
        platformOS !== 'web' &&
        (nativeMountSettleStable || nativeMountSettleDeadlineReached);

    // The session-open latch's own native fallback keeps its previous arming conditions; only
    // the timer that drives it is shared now.
    const nativeLatchFallbackEligibleRef = React.useRef(false);
    nativeLatchFallbackEligibleRef.current =
        platformOS !== 'web' && isLoaded && itemCount > 0;
    const presentationCoveredRef = React.useRef(false);
    presentationCoveredRef.current = presentation.covered;

    // The single bound on the placeholder. One timer per cover episode, armed the first time the
    // placeholder covers; the handle guard means a longer cover cannot extend it. It reveals with
    // `deadline-fallback` and never asserts that the pending paint or placement happened. A cover
    // that ended on its own before the deadline does not latch, so a later legitimate cover — a
    // warm re-entry restoring a detached position into the same mounted session — still gets its
    // own bound. The same timer drives the session-open latch's native fallback, whose only effect
    // is releasing that same placeholder; the entry lifecycle keeps its existing authority to
    // cancel and re-arm the handle across a session entry.
    React.useEffect(() => {
        if (firstPaintDeadlineElapsedSessionId === sessionId) return;
        if (!presentation.covered) return;
        if (nativeFirstPaintFallbackReleaseTimeoutRef.current?.sessionId === sessionId) return;
        const handle = {
            sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (nativeFirstPaintFallbackReleaseTimeoutRef.current === handle) {
                nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            }
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (presentationCoveredRef.current) {
                setFirstPaintDeadlineElapsedSessionId(handle.sessionId);
            }
            if (!nativeLatchFallbackEligibleRef.current) return;
            if (nativeViewportPaintObservedRef.current) return;
            const decision = sessionOpenLatch.onNativeFirstPaintFallbackDeadline({
                nativeViewportPaintObserved: nativeViewportPaintObservedRef.current,
                nowMs: Date.now(),
                sessionId: handle.sessionId,
            });
            applySessionOpenLatchEffectsRef.current(decision.effects);
        }, resolveTranscriptFirstPaintFallbackDelayMs({
            transcriptInitialFillBudgetMs,
            transcriptMountSettleQuiescentWindowMs,
        }));
        nativeFirstPaintFallbackReleaseTimeoutRef.current = handle;
    }, [
        applySessionOpenLatchEffectsRef,
        currentSessionIdRef,
        firstPaintDeadlineElapsedSessionId,
        nativeFirstPaintFallbackReleaseTimeoutRef,
        nativeViewportPaintObservedRef,
        presentation.covered,
        sessionId,
        sessionOpenLatch,
        transcriptInitialFillBudgetMs,
        transcriptMountSettleQuiescentWindowMs,
    ]);

    return {
        nativeFirstPaintReleasedWithoutListLoad,
        onEntryPlacementEvent,
        recordEntryOwnerOutcome,
        resetFirstPaintRevealRecordForSessionEntry,
        showFirstPaintPlaceholder,
        showRouteHydrationFirstPaintPlaceholder,
    };
}
