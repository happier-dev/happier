import * as React from 'react';
import { ActivityIndicator, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
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
import { MessageView } from '@/components/sessions/transcript/MessageView';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { ToolCallsGroupRow } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { buildTranscriptTurnsCached, type TranscriptTurn, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { TurnView } from '@/components/sessions/transcript/turns/TurnView';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { shouldPrefetchOlderFromTop } from '@/components/sessions/transcript/scroll/shouldPrefetchOlderFromTop';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    restoreWebTranscriptPrependAnchor,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export type ChainTranscriptLoadOlderResult = Readonly<{
    loaded: number;
    hasMore: boolean;
    status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
}>;

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
    draftMessages?: Message[];
    metadata: Metadata | null;
    interaction: TranscriptInteraction;
    loadOlder?: () => Promise<ChainTranscriptLoadOlderResult>;
    jumpToMessageId?: string | null;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    messageWrapperTestIdPrefix?: string;
}) {
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const toolViewTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const mergedMessages = React.useMemo(() => {
        if (!Array.isArray(props.draftMessages) || props.draftMessages.length === 0) {
            return props.messages;
        }
        return [...props.messages, ...props.draftMessages];
    }, [props.draftMessages, props.messages]);

    const messageIdsOldestFirst = React.useMemo(() => mergedMessages.map((message) => message.id), [mergedMessages]);
    const messagesById = React.useMemo(() => buildMessagesById(mergedMessages), [mergedMessages]);

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

    const items = React.useMemo<ChainTranscriptListItem[]>(() => {
        if (groupingMode === 'turns') {
            const turns = turnsCache?.turns ?? [];
            return turns.map((turn) => ({ kind: 'turn', id: turn.id, turn }));
        }
        return linearCache?.items ?? buildChatListItems({
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: [],
            discardedMessages: [],
            actionDrafts: [],
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [groupToolCalls, groupingMode, linearCache, messageIdsOldestFirst, messagesById, turnsCache]);

    const latestCommittedMessageId =
        messageIdsOldestFirst.length > 0 ? messageIdsOldestFirst[messageIdsOldestFirst.length - 1]! : null;
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
    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);
    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
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
    }, [thinkingDefaultExpanded]);

    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
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
    }, []);

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

    const loadOlder = React.useCallback(async (options?: Readonly<{ webPrependAnchor?: WebTranscriptScrollMetrics | null }>): Promise<ChainTranscriptLoadOlderResult | null> => {
        const fn = loadOlderRef.current;
        if (!fn) return null;
        if (isLoadingOlderRef.current) return null;
        if (hasMoreOlderRef.current === false) return null;

        isLoadingOlderRef.current = true;
        try {
            const result = await fn();
            if (options?.webPrependAnchor && result.loaded > 0) {
                await waitForNextVisualUpdate();
                restoreWebTranscriptPrependAnchor(options.webPrependAnchor);
            }
            if (result.status === 'no_more' || result.hasMore === false) {
                hasMoreOlderRef.current = false;
            }
            return result;
        } finally {
            isLoadingOlderRef.current = false;
        }
    }, [waitForNextVisualUpdate]);

    const pinToBottom = React.useCallback(() => {
        if (jumpToMessageId) return;
        if (initialPinDoneRef.current) return;
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
    }, [items.length, jumpToMessageId]);

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

    const estimatedItemSize = sync.getSyncTuning().transcriptFlashListEstimatedItemSize;
    const renderItem = React.useCallback(({ item }: { item: ChainTranscriptListItem }) => {
        if (item.kind === 'turn') {
            return (
                <TurnView
                    turn={item.turn}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    activeThinkingMessageId={activeThinkingMessageId}
                    getMessageById={(messageId) => messagesById[messageId] ?? null}
                    expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                    setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                    resolveThinkingExpanded={resolveThinkingExpanded}
                    setThinkingExpanded={setThinkingExpanded}
                    interaction={props.interaction}
                />
            );
        }

        if (item.kind === 'tool-calls-group') {
            return (
                <ToolCallsGroupRow
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    getMessageById={(messageId) => messagesById[messageId] ?? null}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={props.interaction}
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
                <MessageView
                    message={message}
                    metadata={props.metadata}
                    sessionId={props.sessionId}
                    interaction={props.interaction}
                    activeThinkingMessageId={activeThinkingMessageId}
                    thinkingExpanded={isThinking ? resolveThinkingExpanded(message.id) : undefined}
                    onThinkingExpandedChange={isThinking ? (next) => setThinkingExpanded(message.id, next) : undefined}
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
        resolveThinkingExpanded,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        testIdPrefix,
    ]);

    return (
        <FlashList
            ref={(node: FlashListRef<ChainTranscriptListItem> | null) => {
                listRef.current = node;
            }}
            style={{ flex: 1, minHeight: 0 }}
            data={items}
            keyExtractor={(item: ChainTranscriptListItem) => item.id}
            renderItem={renderItem}
            scrollEventThrottle={16}
            onLayout={(e: LayoutChangeEvent) => {
                const h = e?.nativeEvent?.layout?.height;
                if (typeof h !== 'number' || !Number.isFinite(h)) return;
                listLayoutHeightRef.current = h;
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

                const layoutH = listLayoutHeightRef.current;
                const contentH = listContentHeightRef.current;
                if (layoutH <= 0 || contentH <= 0) return;
                if (contentH <= layoutH) return;
                const distanceFromBottom = Math.max(0, Math.trunc(contentH - layoutH - yRaw));
                const topPrefetchThresholdPx = layoutH * 0.2;

                // FlashList's `onStartReached` is not reliably fired on all platforms (notably web),
                // so we also trigger older paging when the scroll position is near the top.
                if (shouldPrefetchOlderFromTop({
                    scrollable: true,
                    offsetY: yRaw,
                    prefetchThresholdPx: topPrefetchThresholdPx,
                    distanceFromBottom,
                    pinThresholdPx: topPrefetchThresholdPx,
                    wantsPinned: true,
                })) {
                    void loadOlder({ webPrependAnchor: buildWebPrependAnchor(topPrefetchThresholdPx) });
                }
            }}
            onStartReachedThreshold={0.2}
            onStartReached={() => {
                const topPrefetchThresholdPx = listLayoutHeightRef.current * 0.2;
                void loadOlder({ webPrependAnchor: buildWebPrependAnchor(topPrefetchThresholdPx) });
            }}
            ListHeaderComponent={
                props.header ? (
                    <View>{props.header}</View>
                ) : null
            }
            ListFooterComponent={
                <>
                    {items.length === 0 ? (
                        <View style={{ paddingVertical: 12 }}>
                            <ActivityIndicator size="small" />
                        </View>
                    ) : null}
                    {props.footer ? <View>{props.footer}</View> : null}
                </>
            }
        />
    );
});
