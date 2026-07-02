import * as React from 'react';
import { Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList, type FlashListRef } from '@/components/ui/lists/flashListCompat/FlashListCompat';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

import {
    buildChatListItems,
    buildChatListItemsCached,
    type ChatListItem,
    type ChatListItemsBuildCache,
} from '@/components/sessions/chatListItems';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { buildTranscriptTurnsCached, type TranscriptTurn, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { TurnViewWithSessionCommon } from '@/components/sessions/transcript/turns/TurnView';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import { resolveLatestCommittedMessageId } from '@/components/sessions/transcript/resolveLatestCommittedMessageId';
import type { SessionRollbackRangeV1 } from '@/sync/domains/sessionRollback/rollbackUiSupport';
import {
    TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
    TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS,
} from '@/components/sessions/transcript/_constants';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import { useTranscriptOlderPagination } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { waitForVisualUpdateWithTimeout } from '@/components/sessions/transcript/pagination/waitForVisualUpdateWithTimeout';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    restoreWebTranscriptPrependByGrowth,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';
import { useOptionalTranscriptSelectionState } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { splitOversizedTranscriptTurnItems } from '@/components/sessions/transcript/turnGrouping/splitOversizedTranscriptTurnItems';

export type ChainTranscriptLoadOlderResult = Readonly<{
    loaded: number;
    hasMore: boolean;
    status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
}>;

type ChainTranscriptLoadOlderOptions = Readonly<{
    webPrependAnchor?: WebTranscriptScrollMetrics | null;
}>;

const EMPTY_ROLLBACK_RANGES: readonly SessionRollbackRangeV1[] = [];

type ChainTranscriptListItem =
    | ChatListItem
    | {
        kind: 'turn';
        id: string;
        turn: TranscriptTurn;
    };

function buildMessagesById(messages: readonly Message[]): Record<string, Message> {
    const result: Record<string, Message> = {};
    for (const message of messages) {
        result[message.id] = message;
    }
    return result;
}

function findLatestThinkingMessage(messages: readonly Message[]): Extract<Message, { kind: 'agent-text' }> | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.kind === 'agent-text' && message.isThinking === true) {
            return message;
        }
    }
    return null;
}

function doesItemContainMessageId(item: ChainTranscriptListItem, messageId: string): boolean {
    if (item.kind === 'message') {
        return item.messageId === messageId;
    }
    if (item.kind === 'tool-calls-group') {
        return item.toolMessageIds.includes(messageId);
    }
    if (item.kind !== 'turn') {
        return false;
    }
    if (item.turn.userMessageId === messageId) {
        return true;
    }
    return item.turn.content.some((entry) => {
        if (entry.kind === 'message') {
            return entry.messageId === messageId;
        }
        return entry.toolMessageIds.includes(messageId);
    });
}

function isWebScrollElementLike(value: unknown): value is HTMLElement {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<HTMLElement>;
    return (
        typeof candidate.scrollTop === 'number' &&
        typeof candidate.scrollHeight === 'number' &&
        typeof candidate.clientHeight === 'number'
    );
}

export const ChainTranscriptList = React.memo(function ChainTranscriptList(props: {
    sessionId: string;
    messages: Message[];
    metadata: Metadata | null;
    interaction: TranscriptInteraction;
    forcePermissionPromptsInTranscript?: boolean;
    loadOlder?: () => Promise<ChainTranscriptLoadOlderResult>;
    jumpToMessageId?: string | null;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    messageWrapperTestIdPrefix?: string;
    // When the list is empty, the footer shows an initial-load spinner. Callers that know whether an
    // initial/older load is genuinely in flight (e.g. sidechain hydration) should pass `false` once
    // the load resolves empty so a legitimately loaded-but-empty list does not spin forever. When
    // omitted, the spinner is shown on an empty list (legacy behavior for the main transcript).
    isInitialLoadInFlight?: boolean;
}) {
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;
    const sessionThinkingDisplayMode = transcriptSessionCommon.messageDisplay.sessionThinkingDisplayMode;
    const sessionThinkingInlinePresentation = transcriptSessionCommon.messageDisplay.sessionThinkingInlinePresentation;
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const messageIdsOldestFirst = React.useMemo(() => props.messages.map((message) => message.id), [props.messages]);
    const messagesById = React.useMemo(() => buildMessagesById(props.messages), [props.messages]);

    const groupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        toolViewTimelineChromeMode === 'activity_feed';
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    const linearItemsCacheRef = React.useRef<ChatListItemsBuildCache | null>(null);
    const turnsCacheRef = React.useRef<TranscriptTurnsBuildCache | null>(null);
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
        return buildTranscriptTurnsCached({
            cache: turnsCacheRef.current,
            messageIdsOldestFirst,
            messagesById,
            groupToolCalls,
            toolCallsGroupStrategy,
        });
    }, [groupToolCalls, groupingMode, messageIdsOldestFirst, messagesById, toolCallsGroupStrategy]);

    React.useEffect(() => {
        turnsCacheRef.current = turnsCache;
    }, [turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return buildChatListItemsCached({
            cache: linearItemsCacheRef.current,
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: [],
            discardedMessages: [],
            actionDrafts: [],
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [groupToolCalls, groupingMode, messageIdsOldestFirst, messagesById]);

    React.useEffect(() => {
        if (groupingMode === 'turns') {
            linearItemsCacheRef.current = null;
            return;
        }
        linearItemsCacheRef.current = linearCache?.cache ?? null;
    }, [groupingMode, linearCache]);

    const syncTuning = sync.getSyncTuning();
    const estimatedItemSize = syncTuning.transcriptFlashListEstimatedItemSize;
    const configuredBackwardPrefetchThresholdPx = syncTuning.transcriptBackwardPrefetchThresholdPx;
    const transcriptMaxTurnEntriesPerListItem = syncTuning.transcriptMaxTurnEntriesPerListItem;

    const items = React.useMemo<ChainTranscriptListItem[]>(() => {
        if (groupingMode === 'turns') {
            const turns = turnsCache?.turns ?? [];
            return splitOversizedTranscriptTurnItems({
                items: turns.map((turn) => ({ kind: 'turn', id: turn.id, turn })),
                maxTurnEntriesPerListItem: transcriptMaxTurnEntriesPerListItem,
                messagesById,
            }) as ChainTranscriptListItem[];
        }
        return linearCache?.items ?? buildChatListItems({
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: [],
            discardedMessages: [],
            actionDrafts: [],
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [groupToolCalls, groupingMode, linearCache, messageIdsOldestFirst, messagesById, transcriptMaxTurnEntriesPerListItem, turnsCache]);

    const latestCommittedMessageId = React.useMemo(() => resolveLatestCommittedMessageId(props.messages), [props.messages]);
    const latestThinkingMessage = React.useMemo(() => findLatestThinkingMessage(props.messages), [props.messages]);
    const latestThinkingMessageId = latestThinkingMessage?.id ?? null;
    const latestThinkingMessageActivityAtMs = latestThinkingMessage?.createdAt ?? null;
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (latestCommittedMessageId == null || latestThinkingMessageId == null) return;
        if (latestCommittedMessageId !== latestThinkingMessageId) return;
        if (typeof latestThinkingMessageActivityAtMs !== 'number') return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        const staleAt = latestThinkingMessageActivityAtMs + staleMs;
        const delayMs = staleAt - Date.now();
        if (delayMs <= 0) return;

        const timer = setTimeout(() => setThinkingPulseNow(Date.now()), delayMs);
        return () => clearTimeout(timer);
    }, [latestCommittedMessageId, latestThinkingMessageActivityAtMs, latestThinkingMessageId, staleMs]);

    const activeThinkingMessageId = React.useMemo(() => {
        return resolveActiveThinkingMessageId({
            sessionThinking: latestCommittedMessageId != null && latestCommittedMessageId === latestThinkingMessageId,
            latestThinkingMessageId,
            latestCommittedMessageId,
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestCommittedMessageId, latestThinkingMessageActivityAtMs, latestThinkingMessageId, staleMs, thinkingPulseNow]);

    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
        () => new Map<string, boolean>(),
    );
    const localTranscriptInteractionDeferredInitialPinRef = React.useRef(false);
    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);
    const deferAutoPinAfterLocalTranscriptInteraction = React.useCallback(() => {
        localTranscriptInteractionDeferredInitialPinRef.current = true;
    }, []);
    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) === expanded) return;
        deferAutoPinAfterLocalTranscriptInteraction();
        setThinkingExpandedByMessageId((prev) => {
            const prevValue = prev.get(messageId);
            if (prevValue === expanded) return prev;
            const next = new Map(prev);
            if (expanded === thinkingDefaultExpanded) {
                next.delete(messageId);
            } else {
                next.set(messageId, expanded);
            }
            return next;
        });
    }, [deferAutoPinAfterLocalTranscriptInteraction, resolveThinkingExpanded, thinkingDefaultExpanded]);

    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        const isExpanded = params.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id));
        if (isExpanded !== params.expanded) {
            deferAutoPinAfterLocalTranscriptInteraction();
        }
        setExpandedToolCallsAnchorMessageIds((prev) => {
            const next = new Set(prev);
            if (params.expanded) {
                const anchor = params.toolMessageIds.length > 0 ? params.toolMessageIds[params.toolMessageIds.length - 1] : null;
                if (typeof anchor === 'string' && anchor.length > 0) {
                    next.add(anchor);
                }
            } else {
                for (const id of params.toolMessageIds) {
                    next.delete(id);
                }
            }
            return next;
        });
    }, [deferAutoPinAfterLocalTranscriptInteraction, expandedToolCallsAnchorMessageIds]);

    React.useEffect(() => {
        // Reset per-session state so derived caches and expansion maps cannot leak across sessions.
        linearItemsCacheRef.current = null;
        turnsCacheRef.current = null;
        localTranscriptInteractionDeferredInitialPinRef.current = false;
        setExpandedToolCallsAnchorMessageIds(new Set());
        setThinkingExpandedByMessageId(new Map());
    }, [props.sessionId]);

    const listRef = React.useRef<FlashListRef<ChainTranscriptListItem> | null>(null);
    const itemsRef = React.useRef<ChainTranscriptListItem[]>(items);
    const loadOlderRef = React.useRef(props.loadOlder);
    const webScrollElementRef = React.useRef<HTMLElement | null>(null);
    const isLoadingOlderRef = React.useRef(false);
    const hasMoreOlderRef = React.useRef(true);
    const initialPinDoneRef = React.useRef(false);
    const listLayoutHeightRef = React.useRef(0);
    const listContentHeightRef = React.useRef(0);
    const jumpAbortRef = React.useRef<AbortController | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const jumpToMessageId =
        typeof props.jumpToMessageId === 'string' && props.jumpToMessageId.trim().length > 0
            ? props.jumpToMessageId.trim()
            : null;
    const testIdPrefix =
        typeof props.messageWrapperTestIdPrefix === 'string' && props.messageWrapperTestIdPrefix.trim().length > 0
            ? props.messageWrapperTestIdPrefix.trim()
            : 'transcript-message';

    React.useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    React.useEffect(() => {
        loadOlderRef.current = props.loadOlder;
    }, [props.loadOlder]);

    const waitForNextVisualUpdate = React.useCallback(async () => {
        await Promise.resolve();
        await Promise.resolve();
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (typeof raf === 'function') {
            await new Promise<void>((resolve) => {
                raf(() => resolve());
            });
        }
    }, []);

    const buildWebPrependAnchor = React.useCallback((pinThresholdPx: number): WebTranscriptScrollMetrics | null => {
        const element = webScrollElementRef.current;
        if (!element) return null;
        const metrics: WebTranscriptScrollMetrics = {
            element,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
        };
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        if (getWebTranscriptDistanceFromBottom(metrics) <= pinThresholdPx) return null;
        return metrics;
    }, []);

    const resolveTopPrefetchThresholdPx = React.useCallback((viewportPx: number): number => {
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: configuredBackwardPrefetchThresholdPx,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, [configuredBackwardPrefetchThresholdPx]);

    const resolveViewportGuardThresholdPx = React.useCallback((viewportPx: number): number => {
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: Number.NaN,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, []);

    const startReachedThreshold = React.useMemo(() => {
        const thresholdPx = resolveTopPrefetchThresholdPx(listLayoutHeight);
        if (thresholdPx <= 0) return 0;
        if (!Number.isFinite(listLayoutHeight) || listLayoutHeight <= 0) {
            return TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO;
        }
        return thresholdPx / listLayoutHeight;
    }, [listLayoutHeight, resolveTopPrefetchThresholdPx]);

    const loadOlder = React.useCallback(async (options: ChainTranscriptLoadOlderOptions = {}): Promise<ChainTranscriptLoadOlderResult | null> => {
        const fn = loadOlderRef.current;
        if (!fn) return null;
        if (isLoadingOlderRef.current) return null;
        if (hasMoreOlderRef.current === false) return null;

        isLoadingOlderRef.current = true;
        try {
            const result = await fn();
            if (options?.webPrependAnchor && result.loaded > 0) {
                // D5 (evidence E10): rAF starvation must not stall the prepend-anchor restore.
                await waitForVisualUpdateWithTimeout({
                    waitForNextVisualUpdate,
                    timeoutMs: TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
                });
                restoreWebTranscriptPrependByGrowth(options.webPrependAnchor);
            }
            if (result.status === 'no_more' || result.hasMore === false) {
                hasMoreOlderRef.current = false;
            }
            return result;
        } finally {
            isLoadingOlderRef.current = false;
        }
    }, [waitForNextVisualUpdate]);

    const paginationLoadOlder = React.useCallback(async (): Promise<ChainTranscriptLoadOlderResult | null> => {
        if (hasMoreOlderRef.current === false) {
            return { loaded: 0, hasMore: false, status: 'no_more' };
        }
        const viewportGuardThresholdPx = resolveViewportGuardThresholdPx(listLayoutHeightRef.current);
        return await loadOlder({ webPrependAnchor: buildWebPrependAnchor(viewportGuardThresholdPx) });
    }, [buildWebPrependAnchor, loadOlder, resolveViewportGuardThresholdPx]);

    // Single owner of user-triggered older pagination (plan D2): the machine-driven hook
    // replaces the deleted dwell scheduler (threshold exit -> enter re-arm, single flight,
    // suspension while offset <= 0, caller-timed cooldown, spinner-delayed indicator).
    const olderPagination = useTranscriptOlderPagination({
        enabled: typeof props.loadOlder === 'function',
        loadOlder: paginationLoadOlder,
        thresholdPx: resolveTopPrefetchThresholdPx(listLayoutHeight),
        cooldownMs: syncTuning.transcriptOlderLoadCooldownMs,
        spinnerDelayMs: syncTuning.transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => true,
        isTransactionOpen: () => false,
    });
    const resetOlderPagination = olderPagination.reset;

    React.useEffect(() => {
        hasMoreOlderRef.current = true;
        resetOlderPagination();
    }, [props.sessionId, resetOlderPagination]);

    const observeOlderPaginationScroll = React.useCallback((offsetY: number) => {
        const layoutH = listLayoutHeightRef.current;
        const contentH = listContentHeightRef.current;
        if (!Number.isFinite(offsetY)) return;
        if (layoutH <= 0 || contentH <= 0 || contentH <= layoutH) {
            olderPagination.onScrollObservation({ offsetY, scrollable: false });
            return;
        }
        const distanceFromBottom = Math.max(0, Math.trunc(contentH - layoutH - offsetY));
        // Follow-mode gate stays consumer-side (Lane D contract): no top prefetch while the
        // viewport sits within the bottom pin guard.
        const viewportGuardThresholdPx = resolveViewportGuardThresholdPx(layoutH);
        olderPagination.onScrollObservation({
            offsetY,
            scrollable: distanceFromBottom > viewportGuardThresholdPx,
        });
    }, [olderPagination, resolveViewportGuardThresholdPx]);

    const pinToBottom = React.useCallback(() => {
        if (jumpToMessageId) return;
        if (initialPinDoneRef.current) return;
        if (localTranscriptInteractionDeferredInitialPinRef.current) return;
        if (items.length === 0) return;

        const layoutH = listLayoutHeightRef.current;
        const contentH = listContentHeightRef.current;
        if (layoutH <= 0 || contentH <= 0) return;

        initialPinDoneRef.current = true;
        try {
            const promise = listRef.current?.scrollToIndex({
                index: items.length - 1,
                animated: false,
                viewPosition: 1,
            });
            promise?.catch(() => {
                const fallbackOffset = Math.max(0, Math.trunc(estimatedItemSize * (items.length - 1)));
                try {
                    listRef.current?.scrollToOffset({ offset: fallbackOffset, animated: false });
                } catch {
                    // Best-effort only.
                }
            });
        } catch {
            // Best-effort only.
        }
    }, [estimatedItemSize, items.length, jumpToMessageId]);

    React.useEffect(() => {
        pinToBottom();
    }, [pinToBottom]);

    React.useEffect(() => {
        if (!jumpToMessageId) return;

        jumpAbortRef.current?.abort();
        const controller = new AbortController();
        jumpAbortRef.current = controller;
        const signal = controller.signal;

        fireAndForget(
            (async () => {
                // Cap work to avoid infinite paging on malformed IDs.
                for (let i = 0; i < 25; i++) {
                    if (signal.aborted) return;
                    const index = itemsRef.current.findIndex((item) => doesItemContainMessageId(item, jumpToMessageId));
                    if (index >= 0) {
                        try {
                            const promise = listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
                            promise?.catch(() => {
                                const offset = Math.max(0, Math.trunc(estimatedItemSize * index));
                                try {
                                    listRef.current?.scrollToOffset({ offset, animated: true });
                                } catch {
                                    // Best-effort only.
                                }
                            });
                        } catch {
                            // Best-effort only.
                        }
                        return;
                    }

                    const result = await loadOlder();
                    if (!result) return;
                    if (signal.aborted) return;
                    if (result.status === 'no_more' || result.hasMore === false) return;

                    // Yield to allow store updates + list re-render before re-checking.
                    await Promise.resolve();
                    await Promise.resolve();
                }
            })(),
            { tag: 'ChainTranscriptList.jumpToMessageId' },
        );

        return () => controller.abort();
    }, [jumpToMessageId, loadOlder]);

    const renderItem = React.useCallback(({ item }: { item: ChainTranscriptListItem }) => {
        if (item.kind === 'turn') {
            return (
                <TurnViewWithSessionCommon
                    turn={item.turn}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    activeThinkingMessageId={activeThinkingMessageId}
                    getMessageById={(messageId) => messagesById[messageId] ?? null}
                    rollbackRanges={EMPTY_ROLLBACK_RANGES}
                    expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                    setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                    resolveThinkingExpanded={resolveThinkingExpanded}
                    setThinkingExpanded={setThinkingExpanded}
                    interaction={props.interaction}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-calls-group') {
            return (
                <ToolCallsGroupRowWithSessionCommon
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    getMessageById={(messageId) => messagesById[messageId] ?? null}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={props.interaction}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind !== 'message') {
            return null;
        }

        const message = messagesById[item.messageId];
        if (!message) return null;
        const isThinking = message.kind === 'agent-text' && message.isThinking === true;

        return (
            <View testID={`${testIdPrefix}-${message.id}`}>
                <MessageViewWithSessionCommon
                    message={message}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    interaction={props.interaction}
                    activeThinkingMessageId={activeThinkingMessageId}
                    thinkingExpanded={isThinking ? resolveThinkingExpanded(message.id) : undefined}
                    onThinkingExpandedChange={isThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            </View>
        );
    }, [
        activeThinkingMessageId,
        expandedToolCallsAnchorMessageIds,
        messagesById,
        props.interaction,
        props.metadata,
        props.sessionId,
        props.forcePermissionPromptsInTranscript,
        resolveThinkingExpanded,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        testIdPrefix,
        transcriptSessionCommon.fork,
        transcriptSessionCommon.messageDisplay,
        transcriptSessionCommon.toolChrome,
        transcriptSessionCommon.toolRoute,
    ]);

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
        <FlashList
            ref={(node: FlashListRef<ChainTranscriptListItem> | null) => {
                listRef.current = node;
            }}
            style={{ flex: 1, minHeight: 0 }}
            data={items}
            extraData={transcriptMessageSelection.selectionVersion}
            keyExtractor={(item: ChainTranscriptListItem) => item.id}
            renderItem={renderItem}
            scrollEventThrottle={
                Platform.OS === 'web'
                    ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                    : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS
            }
            onLayout={(e: LayoutChangeEvent) => {
                const h = e?.nativeEvent?.layout?.height;
                if (typeof h !== 'number' || !Number.isFinite(h)) return;
                if (listLayoutHeightRef.current !== h) {
                    listLayoutHeightRef.current = h;
                    setListLayoutHeight(h);
                }
                pinToBottom();
            }}
            onContentSizeChange={(_w: number, h: number) => {
                if (typeof h !== 'number' || !Number.isFinite(h)) return;
                listContentHeightRef.current = h;
                pinToBottom();
            }}
            onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                const yRaw =
                    e?.nativeEvent?.contentOffset?.y ??
                    (e?.nativeEvent as any)?.target?.scrollTop ??
                    (e as any)?.target?.scrollTop ??
                    null;
                if (typeof yRaw !== 'number' || !Number.isFinite(yRaw)) return;

                const eventTarget = (e?.nativeEvent as any)?.target ?? (e as any)?.target ?? null;
                if (isWebScrollElementLike(eventTarget)) {
                    webScrollElementRef.current = eventTarget;
                }

                // FlashList's `onStartReached` is not reliably fired on all platforms (notably web),
                // so the pagination machine observes every scroll position.
                observeOlderPaginationScroll(yRaw);
            }}
            onStartReachedThreshold={startReachedThreshold}
            onStartReached={() => {
                const element = webScrollElementRef.current;
                if (element) {
                    observeOlderPaginationScroll(element.scrollTop);
                    return;
                }
                const listHandle = listRef.current as (FlashListRef<ChainTranscriptListItem> & {
                    getAbsoluteLastScrollOffset?: () => number;
                }) | null;
                const nativeOffset = (() => {
                    try {
                        const value = listHandle?.getAbsoluteLastScrollOffset?.();
                        if (typeof value === 'number' && Number.isFinite(value)) return value;
                    } catch {
                        return null;
                    }
                    return null;
                })();
                if (typeof nativeOffset === 'number') {
                    observeOlderPaginationScroll(nativeOffset);
                }
            }}
            ListHeaderComponent={
                props.header ? (
                    <View>{props.header}</View>
                ) : null
            }
            ListFooterComponent={
                <>
                    {items.length === 0 && props.isInitialLoadInFlight !== false ? (
                        <View testID="chain-transcript-loading-footer" style={{ paddingVertical: 12 }}>
                            <ActivitySpinner size="small" />
                        </View>
                    ) : null}
                    {props.footer ? <View>{props.footer}</View> : null}
                </>
            }
        />
        {olderPagination.isLoadingOlder ? <OlderLoadProgressOverlay /> : null}
        </View>
    );
});
