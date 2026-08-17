import * as React from 'react';
import { Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

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
import { useSessionCatchingUpNewer } from '@/sync/store/hooks';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { ToolCallsGroupRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { ToolCallsGroupUnitHeaderRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow';
import { ToolCallsGroupUnitExpandRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitExpandRow';
import { ToolCallsGroupUnitToolRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow';
import { ToolCallsGroupUnitFooterRowWithSessionCommon } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitFooterRow';
import { buildTranscriptTurnsCached, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { buildTranscriptTurnUnits, type TranscriptToolGroupUnitItem } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';
import { useOptionalTranscriptSelectionState } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import { resolveLatestCommittedMessageId } from '@/components/sessions/transcript/resolveLatestCommittedMessageId';
import { CatchUpProgressOverlay } from '@/components/sessions/transcript/CatchUpProgressOverlay';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import { useTranscriptOlderPagination } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { resolveItemsToOlderEdge } from '@/components/sessions/transcript/pagination/olderPaginationMachine';
import {
    recordTranscriptViewportTelemetryEvent,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    TranscriptListShell,
    type TranscriptListShellRef,
} from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveSidechainTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import {
    applySidechainJumpToMessageRequest,
} from '@/components/sessions/transcript/viewport/shell/sidechainJumpToMessage';
import {
    createWebDomScrollObservation,
} from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import {
    registerWebTranscriptKeyboardOwner,
    type WebTranscriptKeyboardVerticalDirection,
} from '@/components/sessions/transcript/viewport/lifecycle/webTranscriptKeyboardOwner';
import { createNativeStandardListFactSource } from '@/components/sessions/transcript/viewport/driver/nativeStandardListFacts';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import type {
    TranscriptViewportFactSource,
    TranscriptViewportObservedOffset,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportFacts';
import {
    applySidechainCommittedLayoutObservation,
    applySidechainOlderLoadObservation,
    resolveSidechainOlderLoadEdgeReachedObservation,
    resolveSidechainOlderLoadScrollEventObservation,
    type SidechainOlderLoadObservationInput,
} from '@/components/sessions/transcript/viewport/shell/sidechainOlderLoadObservation';
import {
    applySidechainOlderPageLoad,
    applySidechainPaginationOlderPageLoad,
} from '@/components/sessions/transcript/viewport/shell/sidechainOlderPageLoad';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { useTranscriptMotionConfig } from '@/components/sessions/transcript/motion/useTranscriptMotionConfig';
import {
    TranscriptRowLayoutMutationProvider,
    type TranscriptRowLayoutMutation,
} from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { resolveRowLayoutMutationViewportOwnershipAction } from '@/components/sessions/transcript/viewport/shell/rowLayoutMutationViewportOwnership';

export type ChainTranscriptLoadOlderResult = Readonly<{
    loaded: number;
    hasMore: boolean;
    status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
}>;

type ChainTranscriptListItem =
    | ChatListItem
    | TranscriptToolGroupUnitItem;

type ChainTranscriptCommittedProjection = Readonly<{
    canonicalItems: readonly ChainTranscriptListItem[];
    canonicalSourceIndexById: ReadonlyMap<string, number>;
    datasetKey: string;
    loadOlder: ChainTranscriptListProps['loadOlder'];
    renderedItems: readonly ChainTranscriptListItem[];
}>;

type SidechainOlderPageState = {
    datasetKey: string;
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
};

type ChainTranscriptListProps = Readonly<{
    sessionId: string;
    datasetKey: string;
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
}>;

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

/** Exact ownership: rows that render the message themselves (N2c: a tool unit owns its tool message). */
function doesItemOwnMessageId(item: ChainTranscriptListItem, messageId: string): boolean {
    if (item.kind === 'message') {
        return item.messageId === messageId;
    }
    if (item.kind === 'tool-group-tool') {
        return item.toolMessageId === messageId;
    }
    if (item.kind === 'tool-calls-group') {
        return item.toolMessageIds.includes(messageId);
    }
    return false;
}

/** Containment fallback: the header cap stands in for tools hidden behind a collapsed preview. */
function doesHeaderUnitContainMessageId(item: ChainTranscriptListItem, messageId: string): boolean {
    return item.kind === 'tool-group-header' && item.toolMessageIds.includes(messageId);
}

export const ChainTranscriptList = React.memo(function ChainTranscriptList(props: ChainTranscriptListProps) {
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const toolViewTimelineChromeMode = transcriptSessionCommon.toolChrome.toolViewTimelineChromeMode;
    const sessionThinkingDisplayMode = transcriptSessionCommon.messageDisplay.sessionThinkingDisplayMode;
    const sessionThinkingInlinePresentation = transcriptSessionCommon.messageDisplay.sessionThinkingInlinePresentation;
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const { motionConfig } = useTranscriptMotionConfig();
    const datasetKey = props.datasetKey;
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
    const estimatedItemSize = syncTuning.transcriptEstimatedItemSizePx;
    const configuredBackwardPrefetchThresholdPx = syncTuning.transcriptBackwardPrefetchThresholdPx;
    const shellFrame = React.useMemo(() => resolveSidechainTranscriptListShellFrame({
        platformOS: Platform.OS,
    }), []);
    // §13 catch-up overlay signal. The sidechain list has no live-tail pinned-following composer, so
    // there is no pinned-following streaming case to gate OFF and no
    // composer inset to track — the overlay anchors to the bottom edge (`bottomInset` 0) and shows
    // whenever sync is catching this session up to newer activity (fail-closed signal).
    const isCatchingUpNewer = useSessionCatchingUpNewer(props.sessionId);
    const transcriptToolCallsCollapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');

    // Tool-group expansion state is keyed by anchor message ids (declared before the
    // items memo: N2c per-unit decomposition derives the list rows from it).
    const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );

    const items = React.useMemo<ChainTranscriptListItem[]>(() => {
        if (groupingMode === 'turns') {
            // N2c stable virtualization units: turns decompose into per-unit rows so
            // intra-row tool-group growth becomes between-row insertion.
            const turns = turnsCache?.turns ?? [];
            return buildTranscriptTurnUnits({
                items: turns.map((turn) => ({ kind: 'turn', id: turn.id, turn })),
                getMessageById: (messageId) => messagesById[messageId] ?? null,
                isGroupExpanded: (toolMessageIds) => toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id)),
                collapsedPreviewCount: resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting),
            });
        }
        return linearCache?.items ?? buildChatListItems({
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: [],
            discardedMessages: [],
            actionDrafts: [],
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [expandedToolCallsAnchorMessageIds, groupToolCalls, groupingMode, linearCache, messageIdsOldestFirst, messagesById, transcriptToolCallsCollapsedPreviewCountSetting, turnsCache]);
    const renderedItems = React.useMemo<ChainTranscriptListItem[]>(() => {
        if (shellFrame.dataOrder === 'newest-first') {
            return [...items].reverse();
        }
        return items;
    }, [items, shellFrame.dataOrder]);
    const canonicalSourceIndexById = React.useMemo(() => {
        const sourceIndexById = new Map<string, number>();
        items.forEach((item, index) => {
            sourceIndexById.set(item.id, index);
        });
        return sourceIndexById;
    }, [items]);

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
    const listRef = React.useRef<TranscriptListShellRef<ChainTranscriptListItem> | null>(null);
    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);
    const prepareRowLayoutMutation = React.useCallback((mutation: TranscriptRowLayoutMutation): void => {
        const ownershipAction = resolveRowLayoutMutationViewportOwnershipAction({
            reason: mutation.reason,
        });
        if (ownershipAction === 'arm-visible-anchor-hold') {
            listRef.current?.armVisibleAnchorHold?.();
        }
    }, []);
    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) !== expanded) {
            prepareRowLayoutMutation({
                reason: expanded ? 'expand' : 'collapse',
                sourceId: messageId,
            });
        }
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
    }, [
        prepareRowLayoutMutation,
        resolveThinkingExpanded,
        thinkingDefaultExpanded,
    ]);

    const committedProjection = React.useMemo<ChainTranscriptCommittedProjection>(() => ({
        canonicalItems: items,
        canonicalSourceIndexById,
        datasetKey,
        loadOlder: props.loadOlder,
        renderedItems,
    }), [canonicalSourceIndexById, datasetKey, items, props.loadOlder, renderedItems]);
    const committedProjectionRef = React.useRef<ChainTranscriptCommittedProjection>(committedProjection);
    useCommittedTranscriptRef(committedProjectionRef, committedProjection);
    const webScrollElementRef = React.useRef<HTMLElement | null>(null);
    const webDomObservation = React.useMemo(() => createWebDomScrollObservation(), []);
    const resolveWebKeyboardScroller = React.useCallback((): HTMLElement | null => {
        const rendererNode = listRef.current?.getScrollableNode?.();
        if (typeof HTMLElement !== 'undefined' && rendererNode instanceof HTMLElement) {
            return rendererNode;
        }
        return webScrollElementRef.current;
    }, []);
    const recordWebKeyboardViewportInput = React.useCallback((
        verticalDirection: WebTranscriptKeyboardVerticalDirection,
    ): void => {
        listRef.current?.notifyViewportInput?.({ kind: 'keyboard', verticalDirection });
    }, []);
    React.useEffect(() => {
        if (shellFrame.platform !== 'web' || typeof document === 'undefined') return;
        return registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput: recordWebKeyboardViewportInput,
            resolveScroller: resolveWebKeyboardScroller,
        });
    }, [
        recordWebKeyboardViewportInput,
        resolveWebKeyboardScroller,
        shellFrame.platform,
    ]);
    const olderPageStateRef = React.useRef<SidechainOlderPageState>({
        datasetKey,
        hasMoreOlder: true,
        isLoadingOlder: false,
    });
    const committedOlderPageState = olderPageStateRef.current.datasetKey === datasetKey
        ? olderPageStateRef.current
        : {
            datasetKey,
            hasMoreOlder: true,
            isLoadingOlder: false,
        };
    useCommittedTranscriptRef(olderPageStateRef, committedOlderPageState);
    const listLayoutHeightRef = React.useRef(0);
    const listContentHeightRef = React.useRef(0);
    const nativeStandardFactSourceRef = React.useRef<TranscriptViewportFactSource | null>(null);
    if (Platform.OS !== 'web' && nativeStandardFactSourceRef.current === null) {
        nativeStandardFactSourceRef.current = createNativeStandardListFactSource({
            readRawScrollOffset: () => readNativeAbsoluteScrollOffset(listRef.current) ?? undefined,
            readContentHeight: () => listContentHeightRef.current,
            readLayoutHeight: () => listLayoutHeightRef.current,
            readRenderedVisibleRange: () => {
                try {
                    return listRef.current?.computeVisibleIndices?.() ?? null;
                } catch {
                    return null;
                }
            },
            readFirstVisibleRenderedIndex: () => {
                try {
                    return listRef.current?.getFirstVisibleIndex?.() ?? null;
                } catch {
                    return null;
                }
            },
            readRenderedItemCount: () => committedProjectionRef.current.renderedItems.length,
            readSourceIndexForRenderedIndex: (renderedIndex: number) => {
                const itemId = committedProjectionRef.current.renderedItems[renderedIndex]?.id;
                if (!itemId) return null;
                return committedProjectionRef.current.canonicalSourceIndexById.get(itemId) ?? null;
            },
        });
    }
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
    const loadOlder = React.useCallback(async (): Promise<ChainTranscriptLoadOlderResult | null> => {
        const operationState = olderPageStateRef.current;
        return await applySidechainOlderPageLoad({
            hasMoreOlder: operationState.hasMoreOlder,
            isLoadingOlder: operationState.isLoadingOlder,
            isOperationCurrent: () => (
                olderPageStateRef.current === operationState
                && committedProjectionRef.current.datasetKey === operationState.datasetKey
            ),
            loadOlder: committedProjectionRef.current.loadOlder,
            setHasMoreOlder: (hasMore) => {
                operationState.hasMoreOlder = hasMore;
            },
            setLoadingOlder: (loading) => {
                operationState.isLoadingOlder = loading;
            },
        });
    }, []);

    const paginationLoadOlder = React.useCallback(async (): Promise<ChainTranscriptLoadOlderResult | null> => {
        return await applySidechainPaginationOlderPageLoad({
            hasMoreOlder: olderPageStateRef.current.hasMoreOlder,
            loadOlder,
        });
    }, [loadOlder]);

    // Single owner of user-triggered older pagination (plan D2): the machine-driven hook
    // replaces the deleted dwell scheduler (threshold exit -> enter re-arm, single flight,
    // suspension while offset <= 0, caller-timed cooldown, spinner-delayed indicator).
    const olderPagination = useTranscriptOlderPagination({
        enabled: typeof props.loadOlder === 'function',
        loadOlder: paginationLoadOlder,
        thresholdPx: resolveTopPrefetchThresholdPx(listLayoutHeight),
        thresholdItems: syncTuning.transcriptBackwardPrefetchThresholdItems,
        cooldownMs: syncTuning.transcriptOlderLoadCooldownMs,
        spinnerDelayMs: syncTuning.transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => true,
        isTransactionOpen: () => false,
    });
    const resetOlderPagination = olderPagination.reset;

    React.useEffect(() => {
        resetOlderPagination();
    }, [datasetKey, resetOlderPagination]);

    const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        const isExpanded = params.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id));
        if (isExpanded !== params.expanded) {
            prepareRowLayoutMutation({
                reason: params.expanded ? 'expand' : 'collapse',
                sourceId: params.toolCallsGroupId,
            });
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
    }, [
        expandedToolCallsAnchorMessageIds,
        prepareRowLayoutMutation,
    ]);

    const {
        getSnapshot: getOlderPaginationSnapshot,
        onScrollObservation: dispatchOlderPaginationObservation,
    } = olderPagination;

    const resolveNativeSidechainFactSource = React.useCallback((): TranscriptViewportFactSource | null => {
        if (Platform.OS === 'web') return null;
        return nativeStandardFactSourceRef.current;
    }, []);

    const resolveNativeSidechainObservedOffset = React.useCallback((
        rawOffsetY: number | null | undefined,
    ): TranscriptViewportObservedOffset | null => {
        if (Platform.OS === 'web') return null;
        if (typeof rawOffsetY !== 'number' || !Number.isFinite(rawOffsetY)) return null;
        return resolveNativeSidechainFactSource()?.resolveObservedOffset(rawOffsetY, {
            contentHeight: listContentHeightRef.current,
            layoutHeight: listLayoutHeightRef.current,
        }) ?? null;
    }, [resolveNativeSidechainFactSource]);

    const readCurrentNativeSidechainObservedOffset = React.useCallback((): TranscriptViewportObservedOffset | null => {
        if (Platform.OS === 'web') return null;
        return resolveNativeSidechainObservedOffset(readNativeAbsoluteScrollOffset(listRef.current));
    }, [resolveNativeSidechainObservedOffset]);

    const attachNativeSidechainObservedOffset = React.useCallback((
        observation: SidechainOlderLoadObservationInput,
    ): SidechainOlderLoadObservationInput => {
        if (Platform.OS === 'web') return observation;
        const rawOffsetY = typeof observation === 'number' ? observation : observation.offsetY;
        const nativeObservedOffset = resolveNativeSidechainObservedOffset(rawOffsetY);
        if (!nativeObservedOffset) return observation;
        if (typeof observation === 'number') {
            return {
                nativeObservedOffset,
                offsetY: nativeObservedOffset.canonicalOffsetY,
            };
        }
        return {
            ...observation,
            nativeObservedOffset,
            offsetY: nativeObservedOffset.canonicalOffsetY,
        };
    }, [
        resolveNativeSidechainObservedOffset,
    ]);

    const observeOlderPaginationScroll = React.useCallback((observation: SidechainOlderLoadObservationInput) => {
        // Estimate-immune item-space proximity from the driver fact seam, attached at
        // the ONE observation choke point (scroll + edge-reached callers), mirroring the
        // main list's observation-host attach point: the native canonical px offset is
        // derived from estimated content height, so the pagination machine must not
        // depend on it alone (see the machine contract).
        const itemsToOlderEdge = Platform.OS === 'web'
            ? null
            : resolveItemsToOlderEdge(
                resolveNativeSidechainFactSource()?.getVisibleSourceRange() ?? null,
                committedProjectionRef.current.canonicalItems.length,
            );
        if (
            Platform.OS !== 'web'
            && typeof observation !== 'number'
            && observation.trigger === 'layout-committed'
            && itemsToOlderEdge === null
        ) {
            return;
        }
        const enrichedObservation: SidechainOlderLoadObservationInput =
            itemsToOlderEdge === null
                ? observation
                : (typeof observation === 'number'
                    ? { itemsToOlderEdge, offsetY: observation }
                    : { ...observation, itemsToOlderEdge });
        applySidechainOlderLoadObservation({
            contentHeightPx: listContentHeightRef.current,
            dataOrder: shellFrame.dataOrder,
            listContentHeightPx: listContentHeightRef.current,
            listLayoutHeightPx: listLayoutHeightRef.current,
            getPaginationSnapshot: getOlderPaginationSnapshot,
            itemCount: committedProjectionRef.current.renderedItems.length,
            layoutHeightPx: listLayoutHeightRef.current,
            observation: enrichedObservation,
            onScrollObservation: dispatchOlderPaginationObservation,
            platformOS: Platform.OS,
            recordTelemetry: (event) => recordTranscriptViewportTelemetryEvent(event, syncTuning),
            sessionId: props.sessionId,
            timestampMs: Date.now(),
            viewportGuardThresholdPx: resolveViewportGuardThresholdPx(listLayoutHeightRef.current),
        });
    }, [dispatchOlderPaginationObservation, getOlderPaginationSnapshot, props.sessionId, resolveNativeSidechainFactSource, resolveViewportGuardThresholdPx, syncTuning]);

    const observeCommittedProjectionLayout = React.useCallback(() => {
        applySidechainCommittedLayoutObservation({
            nativeObservedOffset: readCurrentNativeSidechainObservedOffset(),
            onObservation: observeOlderPaginationScroll,
            platformOS: Platform.OS,
            viewportGuardThresholdPx: resolveViewportGuardThresholdPx(listLayoutHeightRef.current),
            webElement: webScrollElementRef.current,
        });
    }, [
        observeOlderPaginationScroll,
        readCurrentNativeSidechainObservedOffset,
        resolveViewportGuardThresholdPx,
    ]);

    const observeRenderedOlderEdge = React.useCallback((reachedEdge: 'start' | 'end') => {
        const resolveReachedEdge = Platform.OS === 'web'
            ? (edge: 'start' | 'end') => edge === 'start' ? 'older' as const : 'newer' as const
            : resolveNativeSidechainFactSource()?.resolveReachedEdge
                ?? (() => 'newer' as const);
        const ingress = resolveSidechainOlderLoadEdgeReachedObservation({
            nativeObservedOffset: readCurrentNativeSidechainObservedOffset(),
            reachedEdge,
            resolveReachedEdge,
            viewportGuardThresholdPx: resolveViewportGuardThresholdPx(listLayoutHeightRef.current),
            webElement: webScrollElementRef.current,
        });
        if (!ingress.ok) return;
        if (ingress.webElement) {
            webScrollElementRef.current = ingress.webElement;
        }
        observeOlderPaginationScroll(ingress.observation);
    }, [
        observeOlderPaginationScroll,
        readCurrentNativeSidechainObservedOffset,
        resolveNativeSidechainFactSource,
        resolveViewportGuardThresholdPx,
    ]);
    const observeRenderedOlderStartEdge = React.useCallback(() => {
        observeRenderedOlderEdge('start');
    }, [observeRenderedOlderEdge]);
    const observeRenderedOlderEndEdge = React.useCallback(() => {
        observeRenderedOlderEdge('end');
    }, [observeRenderedOlderEdge]);

    React.useEffect(() => {
        if (!jumpToMessageId) return;

        jumpAbortRef.current?.abort();
        const controller = new AbortController();
        jumpAbortRef.current = controller;
        const signal = controller.signal;
        const operationId = Symbol('sidechain-explicit-jump');
        const releaseRendererTakeover = listRef.current?.beginExplicitJumpTakeover?.(operationId);

        fireAndForget(
            (async () => {
                try {
                    await applySidechainJumpToMessageRequest({
                        containsMessageId: doesHeaderUnitContainMessageId,
                        estimatedItemSizePx: estimatedItemSize,
                        getItems: () => committedProjectionRef.current.renderedItems,
                        listRef: listRef.current,
                        loadOlder,
                        messageId: jumpToMessageId,
                        ownsMessageId: doesItemOwnMessageId,
                        signal,
                        yieldForRender: async () => {
                            // Yield to allow store updates + list re-render before re-checking.
                            await Promise.resolve();
                            await Promise.resolve();
                        },
                    });
                } finally {
                    releaseRendererTakeover?.();
                    if (jumpAbortRef.current === controller) {
                        jumpAbortRef.current = null;
                    }
                }
            })(),
            { tag: 'ChainTranscriptList.jumpToMessageId' },
        );

        return () => {
            controller.abort();
            releaseRendererTakeover?.();
            if (jumpAbortRef.current === controller) {
                jumpAbortRef.current = null;
            }
        };
    }, [estimatedItemSize, jumpToMessageId, loadOlder]);

    // Stable identity is load-bearing, not hygiene: `useLegendHeldIntent` derives
    // `resolveHeldIntentIndex`/`resolveAnchorHoldDataIndex` -> `readHeldIntentLanding` ->
    // `requestHeldIntentSettle` from it, and the renderer's dataset layout effect depends on that
    // chain. An inline arrow advanced a movement epoch and re-opened a full 1500 ms held-intent
    // settle window on EVERY re-render of this transcript, including ones that changed no row. The
    // main transcript already passes a stable one (`useTranscriptItemsPipeline`, `TranscriptList`).
    const keyExtractor = React.useCallback((item: ChainTranscriptListItem) => item.id, []);

    const renderItem = React.useCallback(({ item }: { item: ChainTranscriptListItem }) => {
        if (item.kind === 'tool-group-header') {
            const headerGroupId = item.groupId;
            const headerToolMessageIds = item.toolMessageIds;
            const toolMessages = item.toolMessageIds
                .map((messageId) => messagesById[messageId] ?? null)
                .filter((message): message is Extract<Message, { kind: 'tool-call' }> => message?.kind === 'tool-call');
            return (
                <ToolCallsGroupUnitHeaderRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={props.interaction}
                    toolMessages={toolMessages}
                    expanded={item.expanded}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: headerGroupId,
                        toolMessageIds: headerToolMessageIds,
                        expanded,
                    })}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-group-expand') {
            const expandGroupId = item.groupId;
            const expandToolMessageIds = item.toolMessageIds;
            return (
                <ToolCallsGroupUnitExpandRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={props.interaction}
                    hiddenCount={item.hiddenCount}
                    setExpanded={(expanded: boolean) => setToolCallsGroupExpanded({
                        toolCallsGroupId: expandGroupId,
                        toolMessageIds: expandToolMessageIds,
                        expanded,
                    })}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-group-tool') {
            const toolMessage = messagesById[item.toolMessageId];
            if (toolMessage?.kind !== 'tool-call') return null;
            return (
                <ToolCallsGroupUnitToolRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
                    interaction={props.interaction}
                    message={toolMessage}
                    expanded={item.expanded}
                    forcePermissionPromptsInTranscript={props.forcePermissionPromptsInTranscript}
                    forkCommon={transcriptSessionCommon.fork}
                    messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                    toolChromeCommon={transcriptSessionCommon.toolChrome}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'tool-group-footer') {
            return (
                <ToolCallsGroupUnitFooterRowWithSessionCommon
                    sessionId={props.sessionId}
                    groupId={item.groupId}
                    metadata={props.metadata}
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
        props.forcePermissionPromptsInTranscript,
        props.interaction,
        props.metadata,
        props.sessionId,
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
        <TranscriptMotionProvider sessionKey={datasetKey} config={motionConfig}>
            <TranscriptRowLayoutMutationProvider value={prepareRowLayoutMutation}>
                <TranscriptListShell<ChainTranscriptListItem>
                    key={datasetKey}
                    ref={(node: TranscriptListShellRef<ChainTranscriptListItem> | null) => {
                        listRef.current = node;
                    }}
                    data={renderedItems}
                    dataKey={datasetKey}
                    extraData={transcriptMessageSelection.selectionVersion}
                    keyExtractor={keyExtractor}
                    renderItem={renderItem}
                    frame={shellFrame}
                    webDomObservation={webDomObservation}
                    onCommitLayoutEffect={observeCommittedProjectionLayout}
                    onLayout={(e: LayoutChangeEvent) => {
                        const h = e?.nativeEvent?.layout?.height;
                        if (typeof h !== 'number' || !Number.isFinite(h)) return;
                        if (listLayoutHeightRef.current !== h) {
                            listLayoutHeightRef.current = h;
                            setListLayoutHeight(h);
                        }
                    }}
                    onContentSizeChange={(_w: number, h: number) => {
                        if (typeof h !== 'number' || !Number.isFinite(h)) return;
                        listContentHeightRef.current = h;
                    }}
                    onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                        const ingress = resolveSidechainOlderLoadScrollEventObservation({
                            event: e,
                            viewportGuardThresholdPx: resolveViewportGuardThresholdPx(listLayoutHeightRef.current),
                        });
                        if (!ingress.ok) return;
                        if (ingress.webElement) {
                            webScrollElementRef.current = ingress.webElement;
                        }

                        // The renderer's `onStartReached` is not reliably fired on all platforms
                        // (notably web), so the pagination machine observes every scroll position.
                        observeOlderPaginationScroll(attachNativeSidechainObservedOffset(ingress.observation));
                    }}
                    onStartReachedThreshold={startReachedThreshold}
                    onStartReached={observeRenderedOlderStartEdge}
                    onEndReachedThreshold={startReachedThreshold}
                    onEndReached={observeRenderedOlderEndEdge}
                    header={
                        props.header ? (
                            <View>{props.header}</View>
                        ) : null
                    }
                    footer={
                        <>
                            {items.length === 0 && props.isInitialLoadInFlight !== false ? (
                                <View testID="chain-transcript-loading-footer" style={{ paddingVertical: 12 }}>
                                    <ActivitySpinner size="small" />
                                </View>
                            ) : null}
                            {props.footer ? <View>{props.footer}</View> : null}
                        </>
                    }
                    olderLoadOverlay={olderPagination.isLoadingOlder ? <OlderLoadProgressOverlay /> : null}
                    catchUpOverlay={(
                        <CatchUpProgressOverlay
                            isCatchingUp={isCatchingUpNewer}
                            bottomInset={0}
                            spinnerDelayMs={syncTuning.transcriptOlderLoadSpinnerDelayMs}
                        />
                    )}
                />
            </TranscriptRowLayoutMutationProvider>
        </TranscriptMotionProvider>
    );
});
