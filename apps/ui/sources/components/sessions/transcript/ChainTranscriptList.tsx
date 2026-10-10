import * as React from 'react';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { resolveTranscriptToolVisibility } from './resolveTranscriptToolVisibility';
import { useTranscriptToolCallsExpansionState } from './rowHost/useTranscriptToolCallsExpansionState';
import { TranscriptSessionActivityLine } from './TranscriptSessionActivityLine';
import { Platform, View } from 'react-native';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import type { Message } from "@happier-dev/session-core/messages";
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

import {
    buildChatListItems,
    buildChatListItemsCached,
    type ChatListItem,
    type ChatListItemsBuildCache,
} from '@/components/sessions/chatListItems';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { PendingMessagesTranscriptBlock } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
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
import { SessionTranscriptSourceProvider, useSessionTranscriptSource } from './source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from './source/readOnlySessionTranscriptSource';
import type { SessionTranscriptSource } from './source/types';
import { useOptionalTranscriptSelectionState } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { resolveLatestCommittedMessageId } from '@/components/sessions/transcript/resolveLatestCommittedMessageId';
import { CatchUpProgressOverlay } from '@/components/sessions/transcript/CatchUpProgressOverlay';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import { OlderLoadRetryOverlay } from '@/components/sessions/transcript/OlderLoadRetryOverlay';
import {
    useTranscriptShellOlderPagination,
} from '@/components/sessions/transcript/pagination/useTranscriptShellOlderPagination';
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
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { useTranscriptMotionConfig } from '@/components/sessions/transcript/motion/useTranscriptMotionConfig';
import {
    TranscriptRowLayoutMutationProvider,
    type TranscriptRowLayoutMutation,
} from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { resolveRowLayoutMutationViewportOwnershipAction } from '@/components/sessions/transcript/viewport/shell/rowLayoutMutationViewportOwnership';

import type { TranscriptOlderPageLoadResult } from "@happier-dev/session-core/messages";

export type ChainTranscriptLoadOlderResult = TranscriptOlderPageLoadResult;

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

type ChainTranscriptListProps = Readonly<{
    sessionId: string;
    /** Exact Home for pending/discarded authorship; raw Session ids repeat across Homes. */
    serverId?: string | null;
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
    // Exact-target pending/discarded rows for this sidechain, already filtered by the canonical
    // pending owner. They participate in the shared transcript projection — including the
    // pending-to-committed crossover — rather than being appended as an arbitrary footer.
    pendingMessages?: readonly PendingMessage[] | null;
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
    // The exact destination those rows belong to. Omitted means the main Session. The
    // pending block re-derives its own filter and every list-scoped mutation (reorder)
    // from this value, so a sidechain that paints a run's queue without it would both
    // show nothing and address the main queue.
    pendingRecipient?: PendingMessage['recipient'];
}>;

const EMPTY_PENDING_MESSAGES: readonly PendingMessage[] = Object.freeze([]);
const EMPTY_DISCARDED_PENDING_MESSAGES: readonly DiscardedPendingMessage[] = Object.freeze([]);

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
    const parentSource = useSessionTranscriptSource();
    // A sidechain is a projection of its parent source, never authority to open
    // app storage beneath a share/demo dataset or re-enable a denied capability.
    const [cell] = React.useState(() => {
        const dataset = createReadOnlySessionTranscriptSource({
            sessionId: parentSource.sessionId, serverId: parentSource.serverId,
            messages: props.messages, metadata: null, reducerState: null, agentState: null,
        });
        let loadOlder = props.loadOlder;
        const branchLoadOlder: NonNullable<SessionTranscriptSource['history']['loadOlder']> = async () => loadOlder
            ? loadOlder()
            : { loaded: 0, hasMore: false, status: 'not_ready' };
        return {
            dataset,
            setLoadOlder: (value: ChainTranscriptListProps['loadOlder']) => { loadOlder = value; },
            source: {
                ...parentSource,
                useMessageIdsOldestFirst: dataset.useMessageIdsOldestFirst,
                useMessagesById: dataset.useMessagesById,
                useMessage: dataset.useMessage,
                useMessagesByIds: dataset.useMessagesByIds,
                history: {
                    ...parentSource.history,
                    loadOlder: props.loadOlder && parentSource.loadSidechain !== null && parentSource.history.loadOlder !== null
                        ? branchLoadOlder : null,
                },
            } satisfies SessionTranscriptSource,
        };
    });
    React.useLayoutEffect(() => {
        cell.dataset.update({ messages: props.messages, metadata: null, reducerState: null, agentState: null });
    }, [cell, props.messages]);
    React.useLayoutEffect(() => { cell.setLoadOlder(props.loadOlder); }, [cell, props.loadOlder]);
    return <SessionTranscriptSourceProvider source={cell.source}>
        <ChainTranscriptListContent {...props} />
    </SessionTranscriptSourceProvider>;
});

function ChainTranscriptListContent(props: ChainTranscriptListProps) {
    const source = useSessionTranscriptSource();
    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptShowToolCalls = useSetting('transcriptShowToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const transcriptSessionCommon = useTranscriptSessionCommon();
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
    const toolVisibility = resolveTranscriptToolVisibility({
        sessionOverride: props.metadata?.work?.viewPreferences?.showToolCalls,
        isBot: readSessionBotV1(props.metadata?.bot) !== null,
        accountShowToolCalls: transcriptShowToolCalls,
        groupToolCalls: transcriptGroupToolCalls === true && toolViewTimelineChromeMode === 'activity_feed',
        collapsedPreviewCount: transcriptSessionCommon.toolChrome.transcriptToolCallsCollapsedPreviewCount,
    });
    const groupToolCalls = toolVisibility.groupToolCalls;
    const toolChromeCommon = React.useMemo(() => ({
        ...transcriptSessionCommon.toolChrome,
        showToolCalls: toolVisibility.showToolCalls,
        transcriptToolCallsCollapsedPreviewCount: toolVisibility.collapsedPreviewCount,
    }), [transcriptSessionCommon.toolChrome, toolVisibility.collapsedPreviewCount, toolVisibility.showToolCalls]);
    const toolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    // Preserve referential stability so an unchanged empty target queue cannot
    // invalidate the transcript projection caches on every render.
    const targetPendingMessages = props.pendingMessages ?? EMPTY_PENDING_MESSAGES;
    const targetDiscardedMessages = props.discardedMessages ?? EMPTY_DISCARDED_PENDING_MESSAGES;

    const linearItemsCacheRef = React.useRef<ChatListItemsBuildCache | null>(null);
    const turnsCacheRef = React.useRef<TranscriptTurnsBuildCache | null>(null);
    const turnsCache = React.useMemo(() => {
        if (groupingMode !== 'turns') return null;
        return buildTranscriptTurnsCached({
            cache: turnsCacheRef.current,
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: targetPendingMessages,
            discardedMessages: targetDiscardedMessages,
            groupToolCalls,
            toolCallsGroupStrategy,
        });
    }, [groupToolCalls, groupingMode, messageIdsOldestFirst, messagesById, targetDiscardedMessages, targetPendingMessages, toolCallsGroupStrategy]);

    React.useEffect(() => {
        turnsCacheRef.current = turnsCache;
    }, [turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return buildChatListItemsCached({
            cache: linearItemsCacheRef.current,
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: targetPendingMessages,
            discardedMessages: targetDiscardedMessages,
            actionDrafts: [],
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [groupToolCalls, groupingMode, messageIdsOldestFirst, messagesById, targetDiscardedMessages, targetPendingMessages]);

    React.useEffect(() => {
        if (groupingMode === 'turns') {
            linearItemsCacheRef.current = null;
            return;
        }
        linearItemsCacheRef.current = linearCache?.cache ?? null;
    }, [groupingMode, linearCache]);

    const syncTuning = sync.getSyncTuning();
    const estimatedItemSize = syncTuning.transcriptEstimatedItemSizePx;
    const shellFrame = React.useMemo(() => resolveSidechainTranscriptListShellFrame({
        platformOS: Platform.OS,
    }), []);
    // §13 catch-up overlay signal. The sidechain list has no live-tail pinned-following composer, so
    // there is no pinned-following streaming case to gate OFF and no
    // composer inset to track — the overlay anchors to the bottom edge (`bottomInset` 0) and shows
    // whenever sync is catching this session up to newer activity (fail-closed signal).
    const isCatchingUpNewer = useSessionCatchingUpNewer(props.sessionId);
    const transcriptToolCallsCollapsedPreviewCountSetting = toolVisibility.collapsedPreviewCount;

    // Tool-group expansion state is keyed by anchor message ids (declared before the
    // items memo: N2c per-unit decomposition derives the list rows from it).
    const listRef = React.useRef<TranscriptListShellRef<ChainTranscriptListItem> | null>(null);
    const prepareRowLayoutMutation = React.useCallback((mutation: TranscriptRowLayoutMutation): void => {
        const ownershipAction = resolveRowLayoutMutationViewportOwnershipAction({ reason: mutation.reason });
        if (ownershipAction === 'arm-visible-anchor-hold') listRef.current?.armVisibleAnchorHold?.();
    }, []);
    const { expandedToolCallsAnchorMessageIds, applyToolCallsGroupExpanded } = useTranscriptToolCallsExpansionState({
        showToolCalls: toolVisibility.showToolCalls,
        prepareExpansionStateChange: prepareRowLayoutMutation,
    });

    const items = React.useMemo<ChainTranscriptListItem[]>(() => {
        if (groupingMode === 'turns') {
            // N2c stable virtualization units: turns decompose into per-unit rows so
            // intra-row tool-group growth becomes between-row insertion.
            const turns = turnsCache?.turns ?? [];
            const turnUnits = buildTranscriptTurnUnits({
                items: turns.map((turn) => ({ kind: 'turn', id: turn.id, turn })),
                getMessageById: (messageId) => messagesById[messageId] ?? null,
                isGroupExpanded: (toolMessageIds) => toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id)),
                collapsedPreviewCount: resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCountSetting),
            });
            // Pending/discarded input is a synthetic transcript row owned by
            // buildChatListItems in linear mode too. Reuse that owner so turn
            // grouping changes only committed-message layout and cannot make
            // the target-scoped Pending queue disappear (including an otherwise
            // empty Run transcript).
            const pendingUnits = buildChatListItems({
                messageIdsOldestFirst,
                messagesById,
                pendingMessages: targetPendingMessages,
                discardedMessages: targetDiscardedMessages,
                actionDrafts: [],
                includeCommittedMessages: false,
            });
            return [...turnUnits, ...pendingUnits];
        }
        return linearCache?.items ?? buildChatListItems({
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: targetPendingMessages,
            discardedMessages: targetDiscardedMessages,
            actionDrafts: [],
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [expandedToolCallsAnchorMessageIds, groupToolCalls, groupingMode, linearCache, messageIdsOldestFirst, messagesById, targetDiscardedMessages, targetPendingMessages, transcriptToolCallsCollapsedPreviewCountSetting, turnsCache]);
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
    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);
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
        loadOlder: source.history.loadOlder ?? undefined,
        renderedItems,
    }), [canonicalSourceIndexById, datasetKey, items, props.loadOlder, renderedItems]);
    const committedProjectionRef = React.useRef<ChainTranscriptCommittedProjection>(committedProjection);
    useCommittedTranscriptRef(committedProjectionRef, committedProjection);
    const webDomObservation = React.useMemo(() => createWebDomScrollObservation(), []);
    const readWebScrollElementRef = React.useRef<() => HTMLElement | null>(() => null);
    const resolveWebKeyboardScroller = React.useCallback((): HTMLElement | null => {
        const rendererNode = listRef.current?.getScrollableNode?.();
        if (typeof HTMLElement !== 'undefined' && rendererNode instanceof HTMLElement) {
            return rendererNode;
        }
        return readWebScrollElementRef.current();
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
    const jumpAbortRef = React.useRef<AbortController | null>(null);
    const jumpToMessageId =
        typeof props.jumpToMessageId === 'string' && props.jumpToMessageId.trim().length > 0
            ? props.jumpToMessageId.trim()
            : null;
    const testIdPrefix =
        typeof props.messageWrapperTestIdPrefix === 'string' && props.messageWrapperTestIdPrefix.trim().length > 0
            ? props.messageWrapperTestIdPrefix.trim()
            : 'transcript-message';

    const olderPagination = useTranscriptShellOlderPagination({
        datasetKey,
        dataOrder: shellFrame.dataOrder,
        listRef,
        loadOlder: source.history.loadOlder ?? undefined,
        readCanonicalItemCount: () => committedProjectionRef.current.canonicalItems.length,
        readRenderedItemCount: () => committedProjectionRef.current.renderedItems.length,
        readSourceIndexForRenderedIndex: (renderedIndex: number) => {
            const itemId = committedProjectionRef.current.renderedItems[renderedIndex]?.id;
            if (!itemId) return null;
            return committedProjectionRef.current.canonicalSourceIndexById.get(itemId) ?? null;
        },
        sessionId: props.sessionId,
    });
    const loadOlder = olderPagination.loadOlder;
    readWebScrollElementRef.current = olderPagination.readWebScrollElement;

    const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
        const isExpanded = params.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id));
        if (isExpanded !== params.expanded) {
            prepareRowLayoutMutation({
                reason: params.expanded ? 'expand' : 'collapse',
                sourceId: params.toolCallsGroupId,
            });
        }
        applyToolCallsGroupExpanded(params);
    }, [
        expandedToolCallsAnchorMessageIds,
        applyToolCallsGroupExpanded,
        prepareRowLayoutMutation,
    ]);


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
                    toolChromeCommon={toolChromeCommon}
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
                    toolChromeCommon={toolChromeCommon}
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
                    toolChromeCommon={toolChromeCommon}
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
                    toolChromeCommon={toolChromeCommon}
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
                    toolChromeCommon={toolChromeCommon}
                    toolRouteCommon={transcriptSessionCommon.toolRoute}
                />
            );
        }

        if (item.kind === 'pending-queue') {
            // The queue is a transcript row, not a footer: it sits at the tail of this exact
            // sidechain and carries its target so edit/reorder/retry/send-now/remove operate
            // on this run's rows only.
            return (
                <PendingMessagesTranscriptBlock
                    sessionId={props.sessionId}
                    serverId={props.serverId ?? null}
                    recipient={props.pendingRecipient}
                    pendingMessages={item.pendingMessages}
                    discardedMessages={item.discardedMessages}
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
                    toolChromeCommon={toolChromeCommon}
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
        props.pendingRecipient,
        props.serverId,
        props.sessionId,
        resolveThinkingExpanded,
        setThinkingExpanded,
        setToolCallsGroupExpanded,
        testIdPrefix,
        transcriptSessionCommon.fork,
        transcriptSessionCommon.messageDisplay,
        toolChromeCommon,
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
                    {...olderPagination.shellProps}
                    header={
                        props.header ? (
                            <View>{props.header}</View>
                        ) : null
                    }
                    footer={
                        <>
                            {!toolVisibility.showToolCalls && source.kind === 'app' && source.serverId ? (
                                <TranscriptSessionActivityLine sessionId={source.sessionId} serverId={source.serverId} />
                            ) : null}
                            {items.length === 0 && props.isInitialLoadInFlight !== false ? (
                                <View testID="chain-transcript-loading-footer" style={{ paddingVertical: 12 }}>
                                    <ActivitySpinner size="small" />
                                </View>
                            ) : null}
                            {props.footer ? <View>{props.footer}</View> : null}
                        </>
                    }
                    olderLoadOverlay={
                        olderPagination.isLoadingOlder
                            ? <OlderLoadProgressOverlay />
                            : olderPagination.loadFailed
                                ? <OlderLoadRetryOverlay onRetry={olderPagination.retryLoad} />
                                : null
                    }
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
}
