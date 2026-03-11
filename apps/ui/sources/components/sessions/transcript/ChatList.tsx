import * as React from 'react';
import {
    getStorage,
    useForkedTranscriptSnapshot,
    useMessage,
    useSession,
    useSessionActionDrafts,
    useSessionLatestThinkingMessageId,
    useSessionLatestThinkingMessageActivityAtMs,
    useSessionMessagesById,
    useSessionPendingMessages,
    useSessionTranscriptIds,
    useSetting,
} from '@/sync/domains/state/storage';
import { ActivityIndicator, FlatList, Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { ChatFooter, type ChatFooterDirectControlState } from './ChatFooter';
import { getSessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';
import { buildChatListItems, buildChatListItemsCached, type ChatListItem, type ChatListItemsBuildCache } from '@/components/sessions/chatListItems';
import { injectForkContextRows } from '@/components/sessions/transcript/forkContext/injectForkContextRows';
import { ForkDividerRow } from '@/components/sessions/transcript/forkContext/ForkDividerRow';
import { PendingMessagesTranscriptBlock } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { SessionActionDraftCard } from '@/components/sessions/actions/SessionActionDraftCard';
import { sync } from '@/sync/sync';
import { getPermissionsInUiWhileLocal } from '@/sync/domains/state/agentStateCapabilities';
import { jumpToTranscriptSeq } from '@/utils/sessions/jumpToTranscriptSeq';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildTranscriptTurnsCached, type TranscriptTurn, type TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { TurnView } from '@/components/sessions/transcript/turns/TurnView';
import { ToolCallsGroupRow } from '@/components/sessions/transcript/toolCalls/ToolCallsGroupRow';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { resolveTranscriptMotionConfig } from '@/components/sessions/transcript/motion/resolveTranscriptMotionConfig';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';
import { reduceTranscriptScrollPinState, type TranscriptScrollPinState } from '@/components/sessions/transcript/scroll/transcriptScrollPinController';
import { shouldPrefetchOlderFromTop } from '@/components/sessions/transcript/scroll/shouldPrefetchOlderFromTop';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { deriveTranscriptInteraction, type TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { buildChatListNativeId } from './chatListNativeId';
import { useWebFlashListCrashFallback } from '@/components/ui/lists/useWebFlashListCrashFallback';
import { buildTranscriptHotColdSegments } from '@/components/sessions/transcript/segments/buildTranscriptHotColdSegments';
import {
    canRollbackLatestTurnConversation,
    isMessageRolledBack,
    readSessionRollbackRangesV1,
    resolveLatestActiveMessageId,
    type SessionRollbackRangeV1,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    resolveWebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { WebTranscriptSplitFooter } from '@/components/sessions/transcript/web/WebTranscriptSplitFooter';
import {
    captureWebTranscriptPrependAnchor,
    refreshWebTranscriptPrependAnchor,
    restoreWebTranscriptPrependAnchor,
    TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    type WebTranscriptPrependAnchor,
} from '@/components/sessions/transcript/webTranscriptPrependAnchor';

type ScrollableChatListRef = Readonly<{
    scrollToIndex: (params: { index: number; animated?: boolean; viewPosition?: number }) => void;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
}>;

type ChatTranscriptListItem =
    | ChatListItem
    | {
        kind: 'turn';
        id: string;
        turn: TranscriptTurn;
    };

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

export const ChatList = React.memo((props: {
    session: Session;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    onRequestSwitchToLocal?: () => void;
    directControlFooter?: ChatFooterDirectControlState;
    jumpToSeq?: number | null;
    onViewportChange?: (state: { isPinned: boolean; offsetY: number }) => void;
}) => {
    const fork = useForkedTranscriptSnapshot(props.session.id);
    const { ids: childMessageIdsOldestFirst, isLoaded } = useSessionTranscriptIds(props.session.id);
    const childMessagesById = useSessionMessagesById(props.session.id);
    const { messages: pendingMessages, discarded: discardedPendingMessages } = useSessionPendingMessages(props.session.id);
    const actionDrafts = useSessionActionDrafts(props.session.id);

    const transcriptGroupingMode = useSetting('transcriptGroupingMode');
    const transcriptGroupToolCalls = useSetting('transcriptGroupToolCalls');
    const transcriptTurnToolCallsGroupStrategy = useSetting('transcriptTurnToolCallsGroupStrategy');
    const toolViewTimelineChromeMode = useSetting('toolViewTimelineChromeMode');

    const forkedTranscriptEnabled = fork != null;

    const forkContextNeedsPrefetch = React.useMemo(() => {
        if (!fork) return false;
        return fork.segments.some((seg) =>
            seg.isReadOnlyContext === true &&
            typeof seg.cutoffSeqInclusive === 'number' &&
            Number.isFinite(seg.cutoffSeqInclusive) &&
            seg.cutoffSeqInclusive >= 0 &&
            (seg.messageIdsOldestFirst?.length ?? 0) === 0
        );
    }, [fork]);

    React.useEffect(() => {
        if (!forkContextNeedsPrefetch) return;
        fireAndForget(sync.prefetchForkedTranscriptContext(props.session.id), { tag: 'ChatList.prefetchForkedTranscriptContext' });
    }, [forkContextNeedsPrefetch, props.session.id]);

    const messageIdsOldestFirst = React.useMemo(() => {
        if (forkedTranscriptEnabled) {
            return fork!.combinedMessageIdsOldestFirst as any as string[];
        }
        return childMessageIdsOldestFirst;
    }, [childMessageIdsOldestFirst, fork, forkedTranscriptEnabled]);
    const messagesById = React.useMemo(() => {
        if (forkedTranscriptEnabled) {
            return fork!.combinedMessagesById as any;
        }
        return childMessagesById;
    }, [childMessagesById, fork, forkedTranscriptEnabled]);

    const groupingMode = forkedTranscriptEnabled ? 'linear' : (transcriptGroupingMode === 'turns' ? 'turns' : 'linear');
    const groupToolCalls =
        transcriptGroupToolCalls === true &&
        (toolViewTimelineChromeMode === 'activity_feed') &&
        forkedTranscriptEnabled !== true;
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
    }, [groupingMode, messageIdsOldestFirst, messagesById, groupToolCalls, toolCallsGroupStrategy]);

    React.useEffect(() => {
        turnsCacheRef.current = turnsCache;
    }, [turnsCache]);

    const linearCache = React.useMemo(() => {
        if (groupingMode === 'turns') return null;
        return buildChatListItemsCached({
            cache: linearItemsCacheRef.current,
            messageIdsOldestFirst,
            messagesById,
            pendingMessages,
            discardedMessages: discardedPendingMessages,
            actionDrafts,
            groupConsecutiveToolCalls: groupToolCalls,
        });
    }, [actionDrafts, groupingMode, groupToolCalls, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages]);

    React.useEffect(() => {
        if (groupingMode === 'turns') {
            linearItemsCacheRef.current = null;
            return;
        }
        linearItemsCacheRef.current = linearCache?.cache ?? null;
    }, [groupingMode, linearCache]);

    const groupedItems = React.useMemo<ChatTranscriptListItem[]>(() => {
        if (groupingMode !== 'turns') {
            const base = linearCache?.items ?? buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages, discardedMessages: discardedPendingMessages, actionDrafts });
            if (!forkedTranscriptEnabled || !fork) return base;
            return injectForkContextRows({ baseItems: base, fork });
        }

        const trailing = buildChatListItems({
            messageIdsOldestFirst,
            messagesById,
            pendingMessages,
            discardedMessages: discardedPendingMessages,
            actionDrafts,
            includeCommittedMessages: false,
        });

        const turns = turnsCache?.turns ?? [];
        const turnItems: ChatTranscriptListItem[] = turns.map((t) => ({ kind: 'turn', id: t.id, turn: t }));
        return [...turnItems, ...trailing];
    }, [actionDrafts, fork, forkedTranscriptEnabled, groupingMode, linearCache, messageIdsOldestFirst, messagesById, pendingMessages, discardedPendingMessages, turnsCache]);

    const latestCommittedActivityKey =
        messageIdsOldestFirst.length > 0 ? messageIdsOldestFirst[messageIdsOldestFirst.length - 1]! : null;
    const rollbackRanges = React.useMemo(
        () => readSessionRollbackRangesV1((props.session.metadata as Record<string, unknown> | null | undefined) ?? null),
        [props.session.metadata],
    );
    const latestActiveCommittedMessageId = React.useMemo(
        () => resolveLatestActiveMessageId({ messageIdsOldestFirst, messagesById, rollbackRanges }),
        [messageIdsOldestFirst, messagesById, rollbackRanges],
    );
    const canRollbackLatestTurn = React.useMemo(
        () => canRollbackLatestTurnConversation({ session: props.session }),
        [props.session],
    );
    const latestRollbackTurnId = React.useMemo(() => {
        if (!canRollbackLatestTurn || groupingMode !== 'turns' || !latestActiveCommittedMessageId) return null;
        const turns = turnsCache?.turns ?? [];
        for (let index = turns.length - 1; index >= 0; index -= 1) {
            const turn = turns[index];
            if (!turn) continue;
            if (turn.userMessageId === latestActiveCommittedMessageId) return turn.id;
            if (turn.content.some((content) =>
                content.kind === 'message'
                    ? content.messageId === latestActiveCommittedMessageId
                    : content.toolMessageIds.includes(latestActiveCommittedMessageId),
            )) {
                return turn.id;
            }
        }
        return null;
    }, [canRollbackLatestTurn, groupingMode, latestActiveCommittedMessageId, turnsCache]);

    const latestThinkingMessageId = useSessionLatestThinkingMessageId(props.session.id);
    const latestThinkingMessageActivityAtMs = useSessionLatestThinkingMessageActivityAtMs(props.session.id);
    const transcriptThinkingPulseStaleMs = useSetting('transcriptThinkingPulseStaleMs');
    const staleMs = typeof transcriptThinkingPulseStaleMs === 'number' && Number.isFinite(transcriptThinkingPulseStaleMs)
        ? transcriptThinkingPulseStaleMs
        : settingsDefaults.transcriptThinkingPulseStaleMs;
    const [thinkingPulseNow, setThinkingPulseNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (props.session.thinking !== true) return;
        if (typeof latestThinkingMessageActivityAtMs !== 'number') return;
        if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) return;

        const staleAt = latestThinkingMessageActivityAtMs + staleMs;
        const delayMs = staleAt - Date.now();
        if (delayMs <= 0) return;

        const t = setTimeout(() => setThinkingPulseNow(Date.now()), delayMs);
        return () => clearTimeout(t);
    }, [latestThinkingMessageActivityAtMs, props.session.thinking, staleMs]);

    const activeThinkingMessageId = React.useMemo(() => {
        return resolveActiveThinkingMessageId({
            sessionThinking: props.session.thinking === true,
            latestThinkingMessageId,
            latestCommittedMessageId: latestCommittedActivityKey,
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestCommittedActivityKey, latestThinkingMessageActivityAtMs, latestThinkingMessageId, props.session.thinking, staleMs, thinkingPulseNow]);

    const interaction = React.useMemo(() => {
        return deriveTranscriptInteraction({
            kind: 'session',
            accessLevel: props.session.accessLevel,
            canApprovePermissions: props.session.canApprovePermissions,
            isSessionActive: props.session.presence === 'online',
        });
    }, [props.session.accessLevel, props.session.canApprovePermissions, props.session.presence]);

        return (
            <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            sessionSeq={props.session.seq ?? 0}
            forkedTranscriptEnabled={forkedTranscriptEnabled}
            items={groupedItems}
            messagesById={messagesById}
            committedMessagesCount={messageIdsOldestFirst.length}
            latestCommittedActivityKey={latestCommittedActivityKey}
            latestActiveCommittedMessageId={latestActiveCommittedMessageId}
            activeThinkingMessageId={activeThinkingMessageId}
            rollbackRanges={rollbackRanges}
            canRollbackLatestTurn={canRollbackLatestTurn}
            latestRollbackTurnId={latestRollbackTurnId}
            isLoaded={isLoaded}
            bottomNotice={props.bottomNotice}
            controlledByUserOverride={props.controlledByUserOverride}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            onRequestSwitchToLocal={props.onRequestSwitchToLocal}
            directControlFooter={props.directControlFooter}
            interaction={interaction}
            jumpToSeq={props.jumpToSeq ?? null}
            onViewportChange={props.onViewportChange}
        />
    )
});

const ListHeader = React.memo((props: { isLoadingOlder: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return (
        <View>
            {props.isLoadingOlder && (
                <View style={{ paddingVertical: 12 }}>
                    <ActivityIndicator size="small" />
                </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const ListFooter = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    onRequestSwitchToLocal?: () => void;
    directControl?: ChatFooterDirectControlState;
}) => {
    const session = useSession(props.sessionId);
    if (!session) {
        return null;
    }
    const permissionsInUiWhileLocal = getPermissionsInUiWhileLocal(session.agentState?.capabilities);
    return (
        <ChatFooter
            controlledByUser={(props.controlledByUserOverride ?? session.agentState?.controlledByUser) || false}
            localControl={getSessionLocalControlState(session)}
            permissionsInUiWhileLocal={permissionsInUiWhileLocal}
            notice={props.bottomNotice ?? null}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            onRequestSwitchToLocal={props.onRequestSwitchToLocal}
            directControl={props.directControl ?? null}
        />
    )
});

const ChatListMessageRow = React.memo(function ChatListMessageRow(props: {
    sessionId: string;
    messageId: string;
    messageOverride?: Message | null;
    originSessionId?: string;
    isReadOnlyContext?: boolean;
    metadata: Metadata | null;
    activeThinkingMessageId: string | null;
    resolveThinkingExpanded: (messageId: string) => boolean;
    setThinkingExpanded: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    showRollbackAction?: boolean;
    historical?: boolean;
}) {
    const originSessionId = props.originSessionId ?? props.sessionId;
    const committedMessage = useMessage(originSessionId, props.messageId);
    const message = props.messageOverride ?? committedMessage;
    if (!message) return null;

    const isThinking = message.kind === 'agent-text' && message.isThinking === true;
    const readOnlyInteraction = props.isReadOnlyContext
        ? {
            ...props.interaction,
            canSendMessages: false,
            canApprovePermissions: false,
            permissionDisabledReason: 'readOnly' as const,
            disableToolNavigation: true,
        }
        : props.interaction;
    return (
        <View testID={`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.messageId}`}>
            <View testID={`transcript-message-${props.messageId}`}>
                <MessageView
                    message={message}
                    metadata={props.metadata}
                    sessionId={originSessionId}
                    activeThinkingMessageId={props.activeThinkingMessageId}
                    thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
                    onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
                    interaction={readOnlyInteraction}
                    showRollbackAction={props.showRollbackAction}
                    historical={props.historical}
                />
            </View>
        </View>
    );
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    sessionSeq: number,
    forkedTranscriptEnabled: boolean,
    items: ChatTranscriptListItem[],
    messagesById: Readonly<Record<string, Message>>,
    committedMessagesCount: number,
    latestCommittedActivityKey: string | null,
    latestActiveCommittedMessageId: string | null,
    activeThinkingMessageId: string | null,
    rollbackRanges: readonly SessionRollbackRangeV1[],
    canRollbackLatestTurn: boolean,
    latestRollbackTurnId: string | null,
    isLoaded: boolean,
    bottomNotice?: ChatListBottomNotice | null,
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void,
    onRequestSwitchToLocal?: () => void,
    directControlFooter?: ChatFooterDirectControlState;
    interaction: TranscriptInteraction;
    jumpToSeq?: number | null;
    onViewportChange?: (state: { isPinned: boolean; offsetY: number }) => void;
}) => {
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const [listContentHeight, setListContentHeight] = React.useState(0);
    const loadOlderInFlight = React.useRef(false);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const itemsRef = React.useRef<ChatTranscriptListItem[]>(props.items);
    const lastJumpSeqRef = React.useRef<number | null>(null);
    const listLayoutHeightRef = React.useRef<number>(0);
    const listContentHeightRef = React.useRef<number>(0);
    const initialFillStatusRef = React.useRef<'idle' | 'in_progress' | 'done'>('idle');
    const initialPinSessionIdRef = React.useRef<string | null>(null);
    const didAutoExpandToolCallsGroupsForSessionRef = React.useRef<string | null>(null);
    const initialFillAbortRef = React.useRef<AbortController | null>(null);
    const chatListReactId = React.useId();
    const chatListNativeId = React.useMemo(() => buildChatListNativeId(props.sessionId, chatListReactId), [props.sessionId, chatListReactId]);
    const loadNewerInFlight = React.useRef(false);
    const webScrollContainerRef = React.useRef<HTMLElement | null>(null);
    const pendingWebPrependAnchorRef = React.useRef<ReturnType<typeof captureWebTranscriptPrependAnchor> | null>(null);
    const inFlightWebPrependAnchorRef = React.useRef<ReturnType<typeof captureWebTranscriptPrependAnchor> | null>(null);
    const pendingWebPrependIndexRecoveryRef = React.useRef(false);
    const scheduledWebPrependIndexRecoveryRef = React.useRef<{ kind: 'raf' | 'timeout'; ids: any[] } | null>(null);
      const wantsPinnedRef = React.useRef(true);
      const lastUserScrollIntentAtMsRef = React.useRef(0);
      const lastAutoRepinAtMsRef = React.useRef(0);
      const lastPinOffsetForIntentRef = React.useRef<number | null>(null);
    const initialWebPinStabilizingRef = React.useRef(false);

    const transcriptMotionPreset = useSetting('transcriptMotionPreset');
    const transcriptMotionFreshnessMs = useSetting('transcriptMotionFreshnessMs');
    const transcriptAnimateNewItemsEnabled = useSetting('transcriptAnimateNewItemsEnabled');
    const transcriptAnimateToolExpandCollapseEnabled = useSetting('transcriptAnimateToolExpandCollapseEnabled');
    const transcriptAnimateToolExpandCollapseFreshOnly = useSetting('transcriptAnimateToolExpandCollapseFreshOnly');
  const transcriptAnimateThinkingEnabled = useSetting('transcriptAnimateThinkingEnabled');
  const reducedMotionPreferred = useReducedMotionPreference();
    const sessionThinkingDisplayMode = useSetting('sessionThinkingDisplayMode');
    const sessionThinkingInlinePresentation = useSetting('sessionThinkingInlinePresentation');
    const sessionThinkingInlineChrome = useSetting('sessionThinkingInlineChrome');

      const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
      // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
      // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
      // Stopping propagation here keeps the event within the transcript subtree so native scrolling works.
      if (Platform.OS !== 'web') return;
          const nowMs = Date.now();
          lastUserScrollIntentAtMsRef.current = nowMs;
        // If the user scrolls upward (away from the bottom), treat that as explicit intent to unpin
        // immediately, even if they remain within the pinned threshold. This prevents mount-time
        // stabilization retries from fighting the user for several seconds after entering a session.
        const deltaY = (event as any)?.deltaY;
        if (typeof deltaY === 'number' && Number.isFinite(deltaY) && deltaY < 0) {
            wantsPinnedRef.current = false;
        }
      if (typeof event?.stopPropagation === 'function') event.stopPropagation();
      }, []);

        const markUserScrollIntentOnWeb = React.useCallback(() => {
            if (Platform.OS !== 'web') return;
            lastUserScrollIntentAtMsRef.current = Date.now();
        }, []);

    const resolveWebScrollMetrics = React.useCallback(() => {
        if (Platform.OS !== 'web') return null;
        if (typeof document === 'undefined') return null;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;

        const root = (document as any)?.getElementById?.(chatListNativeId) as HTMLElement | null | undefined;
        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            cachedElement: webScrollContainerRef.current,
            win: window,
            minOverflowPx: 50,
            maxDescendants: 1800,
            maxAncestors: 30,
            pick: 'best',
            allowRootFallback: true,
            score: (el) => {
                const sh = (el as any).scrollHeight;
                return typeof sh === 'number' && Number.isFinite(sh) ? sh : 0;
            },
        });
        if (metrics) {
            webScrollContainerRef.current = metrics.element;
        }
        return metrics;
    }, [chatListNativeId]);

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

  const motionConfig = React.useMemo(() => {
    return resolveTranscriptMotionConfig({
      reducedMotionPreferred,
      transcriptMotionPreset,
            transcriptMotionFreshnessMs,
            transcriptAnimateNewItemsEnabled,
            transcriptAnimateToolExpandCollapseEnabled,
            transcriptAnimateToolExpandCollapseFreshOnly,
            transcriptAnimateThinkingEnabled,
        });
    }, [
        reducedMotionPreferred,
        transcriptAnimateNewItemsEnabled,
        transcriptAnimateThinkingEnabled,
        transcriptAnimateToolExpandCollapseEnabled,
        transcriptAnimateToolExpandCollapseFreshOnly,
        transcriptMotionFreshnessMs,
        transcriptMotionPreset,
    ]);

    const transcriptScrollPinEnabled = useSetting('transcriptScrollPinEnabled');
    const transcriptScrollPinOffsetThresholdPx = useSetting('transcriptScrollPinOffsetThresholdPx');
    const transcriptScrollAutoFollowWhenPinned = useSetting('transcriptScrollAutoFollowWhenPinned');
    const transcriptScrollJumpToBottomEnabled = useSetting('transcriptScrollJumpToBottomEnabled');
    const transcriptScrollJumpToBottomMinNewCount = useSetting('transcriptScrollJumpToBottomMinNewCount');
    const transcriptScrollJumpToBottomAnimateScroll = useSetting('transcriptScrollJumpToBottomAnimateScroll');
    const transcriptListImplementation = useSetting('transcriptListImplementation');
    const transcriptToolCallsCollapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');

      const [scrollPin, setScrollPin] = React.useState<TranscriptScrollPinState>({
          isPinned: true,
          newActivityCount: 0,
          lastActivityKey: null,
      });
      const isPinnedRef = React.useRef(true);
      const [expandedToolCallsAnchorMessageIds, setExpandedToolCallsAnchorMessageIds] = React.useState<ReadonlySet<string>>(
          () => new Set<string>(),
      );
        const thinkingDefaultExpanded =
            sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
        const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
            () => new Map<string, boolean>(),
        );

      const setToolCallsGroupExpanded = React.useCallback((params: { toolCallsGroupId: string; toolMessageIds: readonly string[]; expanded: boolean }) => {
          setExpandedToolCallsAnchorMessageIds((prev) => {
              const next = new Set(prev);
              if (params.expanded) {
                  const toolMessageIds = params.toolMessageIds;
                  const anchor = toolMessageIds.length > 0 ? toolMessageIds[toolMessageIds.length - 1] : null;
                  if (typeof anchor === 'string' && anchor) {
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

    React.useEffect(() => {
        props.onViewportChange?.({ isPinned: isPinnedRef.current, offsetY: 0 });
    }, [props.onViewportChange]);

    React.useEffect(() => {
        return () => {
            initialFillAbortRef.current?.abort();
            initialFillAbortRef.current = null;
        };
    }, []);

    React.useEffect(() => {
        // Reset per-session state.
        initialFillAbortRef.current?.abort();
        initialFillAbortRef.current = null;
        initialFillStatusRef.current = 'idle';
        didAutoExpandToolCallsGroupsForSessionRef.current = null;
        inFlightWebPrependAnchorRef.current = null;
        pendingWebPrependAnchorRef.current = null;
        pendingWebPrependIndexRecoveryRef.current = false;
        const scheduledRecovery = scheduledWebPrependIndexRecoveryRef.current;
        if (scheduledRecovery) {
            scheduledWebPrependIndexRecoveryRef.current = null;
            if (scheduledRecovery.kind === 'raf') {
                for (const id of scheduledRecovery.ids) {
                    cancelAnimationFrame(id);
                }
            } else {
                for (const id of scheduledRecovery.ids) {
                    clearTimeout(id);
                }
            }
        }
        setExpandedToolCallsAnchorMessageIds(new Set());
    }, [props.sessionId]);

    const pinEnabled = transcriptScrollPinEnabled !== false;
    const pinThresholdPx =
        typeof transcriptScrollPinOffsetThresholdPx === 'number' && Number.isFinite(transcriptScrollPinOffsetThresholdPx)
            ? Math.max(0, Math.trunc(transcriptScrollPinOffsetThresholdPx))
            : 72;
    const autoFollowWhenPinned = transcriptScrollAutoFollowWhenPinned !== false;
    const jumpEnabled = transcriptScrollJumpToBottomEnabled !== false;
    const jumpMinNewCount =
        typeof transcriptScrollJumpToBottomMinNewCount === 'number' && Number.isFinite(transcriptScrollJumpToBottomMinNewCount)
            ? Math.max(1, Math.trunc(transcriptScrollJumpToBottomMinNewCount))
            : 1;
    const jumpAnimateScroll = transcriptScrollJumpToBottomAnimateScroll !== false;

    const preferredListImplementation = transcriptListImplementation === 'flatlist_legacy' ? 'flatlist_legacy' : 'flash_v2';
    const webFlashListCrashed = useWebFlashListCrashFallback({
        enabled: Platform.OS === 'web' && preferredListImplementation === 'flash_v2',
    });
    const listImplementation =
        Platform.OS === 'web' && preferredListImplementation === 'flash_v2' && webFlashListCrashed
            ? 'flatlist_legacy'
            : preferredListImplementation;

    const displayItems = React.useMemo(() => {
        if (listImplementation === 'flatlist_legacy') {
            // Legacy: inverted lists expect newest-first input.
            return [...props.items].reverse();
        }
        return props.items;
    }, [listImplementation, props.items]);
    const transcriptHotColdSegments = React.useMemo(() => {
        const tuning = sync.getSyncTuning();
        return buildTranscriptHotColdSegments({
            enabled: listImplementation === 'flash_v2',
            hotTailItemCount: tuning.transcriptWebHotTailItemCount,
            items: displayItems,
            activeThinkingMessageId: props.activeThinkingMessageId,
            expandedToolCallsAnchorMessageIds,
        });
    }, [displayItems, expandedToolCallsAnchorMessageIds, listImplementation, props.activeThinkingMessageId]);
    const shouldUseWebHotColdSplit =
        Platform.OS === 'web' &&
        listImplementation === 'flash_v2' &&
        transcriptHotColdSegments.hotItems.length > 0;
    const listData = shouldUseWebHotColdSplit ? transcriptHotColdSegments.coldItems : displayItems;

    // Keep a synchronous view of the current list items for effects that run between renders
    // (e.g. initial viewport fill and jump-to-seq resolution).
    itemsRef.current = displayItems;

    const flashListMaintainVisibleContentPosition = React.useMemo(() => {
        // FlashList/web can throw "index out of bounds, not enough layouts" under heavy append + scroll
        // when `maintainVisibleContentPosition.startRenderingFromBottom` is enabled. On web we already
        // pin via direct DOM scroll writes, so omit this prop to avoid the crash.
        if (Platform.OS === 'web') return undefined;
        return { startRenderingFromBottom: true } as const;
    }, []);

    const flatListMaintainVisibleContentPosition = React.useMemo(() => {
        return pinEnabled && autoFollowWhenPinned
            ? { minIndexForVisible: 0, autoscrollToTopThreshold: pinThresholdPx }
            : undefined;
    }, [autoFollowWhenPinned, pinEnabled, pinThresholdPx]);

    const resolveCreatedAtForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState() as any;
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const createdAt = message?.createdAt;
        return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null;
    }, [props.sessionId]);

    const resolveSeqForMessageId = React.useCallback((messageId: string): number | null => {
        const state = getStorage().getState() as any;
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const seq = message?.seq;
        return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
    }, [props.sessionId]);

    const resolveKindForMessageId = React.useCallback((messageId: string): string | null => {
        const state = getStorage().getState() as any;
        const session = state?.sessionMessages?.[props.sessionId];
        const message = session?.messagesById?.[messageId] ?? session?.messagesMap?.[messageId] ?? null;
        const kind = message?.kind;
        return typeof kind === 'string' ? kind : null;
    }, [props.sessionId]);

    const resolveTurnMessageById = React.useCallback((messageId: string): Message | null => {
        return props.messagesById[messageId] ?? null;
    }, [props.messagesById]);

    const toolTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const keyExtractor = useCallback((item: ChatTranscriptListItem) => item.id, []);
    const getItemType = useCallback((item: ChatTranscriptListItem): string => item.kind, []);
    const wrapTranscriptItemForAnchor = React.useCallback((itemId: string, node: React.ReactNode) => {
        return (
            <View testID={`${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${itemId}`}>
                {node}
            </View>
        );
    }, []);

    const captureCurrentWebPrependAnchor = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        if (getWebTranscriptDistanceFromBottom(metrics) <= pinThresholdPx) return null;
        const tuning = sync.getSyncTuning();
        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
            stabilizeForMs: tuning.transcriptWebInitialPinStabilizeMs,
        });
        return anchor;
    }, [listImplementation, pinThresholdPx, resolveWebScrollMetrics]);

    const refreshInFlightWebPrependAnchor = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        const currentAnchor = inFlightWebPrependAnchorRef.current;
        if (!currentAnchor) return;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return;
        if (!isWebTranscriptScrollable(metrics, 1)) return;
        inFlightWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(currentAnchor, {
            ...metrics,
            scrollHeight: currentAnchor.metrics.scrollHeight,
        }, {
            recaptureAnchor: true,
            userIntentAtMs: lastUserScrollIntentAtMsRef.current,
        });
    }, [listImplementation, resolveWebScrollMetrics]);

    const resolvePendingWebPrependRefreshOptions = React.useCallback((strategy: 'anchor' | 'item' | 'growth' | 'none') => {
        if (strategy === 'anchor') {
            return { recaptureAnchor: true, recaptureItem: true } as const;
        }
        if (strategy === 'item') {
            return { recaptureItem: true } as const;
        }
        return { preserveBaselineMetrics: true } as const;
    }, []);

    const resolvePendingWebPrependItemIndex = React.useCallback((itemTestId: string | null): number | null => {
        if (!itemTestId?.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) return null;
        const itemId = itemTestId.slice(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        const index = itemsRef.current.findIndex((item) => item.id === itemId);
        return index >= 0 ? index : null;
    }, []);

    const resolvePendingWebPrependAnchorIndex = React.useCallback((anchorTestId: string | null): number | null => {
        let anchorMessageId: string | null = null;
        if (anchorTestId?.startsWith(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        } else if (anchorTestId?.startsWith(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            anchorMessageId = anchorTestId.slice(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX.length);
        }
        if (!anchorMessageId) return null;

        const index = itemsRef.current.findIndex((item) => {
            if (item.kind === 'message') {
                return item.messageId === anchorMessageId;
            }
            if (item.kind === 'tool-calls-group') {
                return item.toolMessageIds.includes(anchorMessageId);
            }
            if (item.kind === 'turn') {
                if (item.turn.userMessageId === anchorMessageId) return true;
                return item.turn.content.some((content) => {
                    if (content.kind === 'message') {
                        return content.messageId === anchorMessageId;
                    }
                    if (content.kind === 'tool_calls') {
                        return content.toolMessageIds.includes(anchorMessageId);
                    }
                    return false;
                });
            }
            return false;
        });

        return index >= 0 ? index : null;
    }, []);

    const resolvePendingWebPrependRecoveryIndex = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): number | null => {
        if (!pendingAnchor) return null;
        return resolvePendingWebPrependAnchorIndex(pendingAnchor.anchorTestId) ?? resolvePendingWebPrependItemIndex(pendingAnchor.itemTestId);
    }, [resolvePendingWebPrependAnchorIndex, resolvePendingWebPrependItemIndex]);

    const tryScrollPendingWebPrependItemIntoView = React.useCallback((pendingAnchor: WebTranscriptPrependAnchor | null): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        const index = resolvePendingWebPrependRecoveryIndex(pendingAnchor);
        if (index == null) return false;
        const node = listRef.current;
        if (!node || typeof node.scrollToIndex !== 'function') return false;
        try {
            node.scrollToIndex({ index, animated: false, viewPosition: 0 });
            return true;
        } catch {
            return false;
        }
    }, [listImplementation, resolvePendingWebPrependRecoveryIndex]);

    const attemptPendingWebPrependIndexRecovery = React.useCallback((): boolean => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return false;
        if (!pendingWebPrependIndexRecoveryRef.current || !pendingWebPrependAnchorRef.current) return false;
        const didRecoverIndex = tryScrollPendingWebPrependItemIntoView(pendingWebPrependAnchorRef.current);
        if (!didRecoverIndex) return false;

        pendingWebPrependIndexRecoveryRef.current = false;
        const retryAnchor = pendingWebPrependAnchorRef.current;
        const retryRestoreResult = restoreWebTranscriptPrependAnchor(retryAnchor);
        const retryMetrics = resolveWebScrollMetrics();
        if (!retryMetrics) {
            pendingWebPrependAnchorRef.current = null;
            return true;
        }
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
            retryAnchor,
            retryMetrics,
            resolvePendingWebPrependRefreshOptions(retryRestoreResult.strategy),
        );
        return true;
    }, [
        listImplementation,
        resolvePendingWebPrependRefreshOptions,
        resolveWebScrollMetrics,
        tryScrollPendingWebPrependItemIntoView,
    ]);

    const schedulePendingWebPrependIndexRecovery = React.useCallback(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;
        const scheduledRecovery = scheduledWebPrependIndexRecoveryRef.current;
        if (scheduledRecovery) return;

        if (typeof requestAnimationFrame === 'function') {
            const handle: { kind: 'raf'; ids: any[] } = { kind: 'raf', ids: [] };
            scheduledWebPrependIndexRecoveryRef.current = handle;
            const first = requestAnimationFrame(() => {
                const second = requestAnimationFrame(() => {
                    if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
                    scheduledWebPrependIndexRecoveryRef.current = null;
                    attemptPendingWebPrependIndexRecovery();
                });
                handle.ids.push(second);
            });
            handle.ids.push(first);
            return;
        }

        const handle: { kind: 'timeout'; ids: any[] } = { kind: 'timeout', ids: [] };
        scheduledWebPrependIndexRecoveryRef.current = handle;
        const timeoutId = setTimeout(() => {
            if (scheduledWebPrependIndexRecoveryRef.current !== handle) return;
            scheduledWebPrependIndexRecoveryRef.current = null;
            attemptPendingWebPrependIndexRecovery();
        }, 0);
        handle.ids.push(timeoutId);
    }, [attemptPendingWebPrependIndexRecovery, listImplementation]);

      const renderItem = useCallback(({ item, index }: { item: ChatTranscriptListItem; index: number }) => {
          if (item.kind === 'action-draft') {
              return wrapTranscriptItemForAnchor(item.id, <SessionActionDraftCard sessionId={props.sessionId} draft={item.draft} />);
          }
        if (item.kind === 'fork-divider') {
            return wrapTranscriptItemForAnchor(item.id, (
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
            return wrapTranscriptItemForAnchor(item.id, (
                <TranscriptEnterWrapper id={item.id} createdAt={createdAt}>
                    <PendingMessagesTranscriptBlock
                        sessionId={props.sessionId}
                        pendingMessages={item.pendingMessages}
                        discardedMessages={item.discardedMessages}
                    />
                </TranscriptEnterWrapper>
            ));
        }
        if (item.kind === 'tool-calls-group') {
            return wrapTranscriptItemForAnchor(item.id, (
                <ToolCallsGroupRow
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    expanded={item.toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))}
                    onSetExpanded={setToolCallsGroupExpanded}
                    interaction={props.interaction}
                />
            ));
        }
        if (item.kind === 'turn') {
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
            return wrapTranscriptItemForAnchor(item.id, (
                <TranscriptEnterWrapper id={item.id} createdAt={turnCreatedAt}>
                      <TurnView
                          turn={item.turn}
                          metadata={props.metadata}
                          sessionId={props.sessionId}
                          interaction={props.interaction}
                          showRollbackAction={props.canRollbackLatestTurn && props.latestRollbackTurnId === item.turn.id}
                          activeThinkingMessageId={props.activeThinkingMessageId}
                          getMessageById={resolveTurnMessageById}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                          expandedToolCallsAnchorMessageIds={expandedToolCallsAnchorMessageIds}
                          setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                      />
                  </TranscriptEnterWrapper>
              ));
          }
        if (item.kind === 'message') {
            const toolChromeMode = toolTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';
            const prev = listImplementation === 'flash_v2' ? itemsRef.current[index - 1] : undefined;
            const shouldTightenToolStack =
                listImplementation === 'flash_v2' &&
                toolChromeMode === 'activity_feed' &&
                resolveKindForMessageId(item.messageId) === 'tool-call' &&
                prev?.kind === 'message' &&
                resolveKindForMessageId(prev.messageId) === 'tool-call';
            const wrapperStyle = shouldTightenToolStack ? { marginTop: -12 } : undefined;

            return wrapTranscriptItemForAnchor(item.id, (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <View style={wrapperStyle}>
                        <ChatListMessageRow
                            sessionId={props.sessionId}
                            messageId={item.messageId}
                            messageOverride={props.messagesById[item.messageId] ?? null}
                            originSessionId={item.originSessionId}
                            isReadOnlyContext={item.isReadOnlyContext}
                            metadata={props.metadata}
                            activeThinkingMessageId={props.activeThinkingMessageId}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                            interaction={props.interaction}
                            showRollbackAction={props.canRollbackLatestTurn && props.latestActiveCommittedMessageId === item.messageId}
                            historical={isMessageRolledBack({ message: props.messagesById[item.messageId] ?? null, rollbackRanges: props.rollbackRanges })}
                        />
                    </View>
                </TranscriptEnterWrapper>
            ));
        }
        return null;
      }, [expandedToolCallsAnchorMessageIds, listImplementation, props.activeThinkingMessageId, props.canRollbackLatestTurn, props.interaction, props.latestActiveCommittedMessageId, props.latestRollbackTurnId, props.messagesById, props.metadata, props.rollbackRanges, props.sessionId, resolveCreatedAtForMessageId, resolveKindForMessageId, resolveThinkingExpanded, resolveTurnMessageById, setThinkingExpanded, setToolCallsGroupExpanded, toolTimelineChromeMode, wrapTranscriptItemForAnchor]);
    const renderTranscriptItemAtIndex = React.useCallback((item: ChatTranscriptListItem, index: number) => {
        return renderItem({ item, index });
    }, [renderItem]);
    const listFooterNode = React.useMemo(() => (
        <ListFooter
            sessionId={props.sessionId}
            bottomNotice={props.bottomNotice}
            controlledByUserOverride={props.controlledByUserOverride}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            onRequestSwitchToLocal={props.onRequestSwitchToLocal}
            directControl={props.directControlFooter}
        />
    ), [
        props.bottomNotice,
        props.controlSwitchTo,
        props.controlledByUserOverride,
        props.directControlFooter,
        props.onRequestSwitchToLocal,
        props.onRequestSwitchToRemote,
        props.sessionId,
    ]);
    const flashListFooterNode = React.useMemo(() => {
        if (!shouldUseWebHotColdSplit) {
            return listFooterNode;
        }
        return (
            <WebTranscriptSplitFooter
                hotItems={transcriptHotColdSegments.hotItems}
                startIndex={transcriptHotColdSegments.coldItems.length}
                renderItemAtIndex={renderTranscriptItemAtIndex}
                footer={listFooterNode}
            />
        );
    }, [
        listFooterNode,
        renderTranscriptItemAtIndex,
        shouldUseWebHotColdSplit,
        transcriptHotColdSegments.coldItems.length,
        transcriptHotColdSegments.hotItems,
    ]);

    const loadOlder = useCallback(async (): Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null> => {
        if (!props.isLoaded && props.forkedTranscriptEnabled !== true) return null;
        if (loadOlderInFlight.current || hasMoreOlder === false) {
            return null;
        }
        loadOlderInFlight.current = true;
        setIsLoadingOlder(true);
        try {
            inFlightWebPrependAnchorRef.current = captureCurrentWebPrependAnchor();

            const result = props.forkedTranscriptEnabled
                ? await sync.loadOlderMessagesForkAware(props.sessionId)
                : await sync.loadOlderMessages(props.sessionId);

            const webPrependAnchor = inFlightWebPrependAnchorRef.current;
            inFlightWebPrependAnchorRef.current = null;

            if (webPrependAnchor && result.loaded > 0) {
                pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
                    webPrependAnchor,
                    webPrependAnchor.metrics,
                    {
                        resetExpiry: true,
                        userIntentAtMs: lastUserScrollIntentAtMsRef.current,
                    },
                );
                const restoreResult = restoreWebTranscriptPrependAnchor(pendingWebPrependAnchorRef.current);
                const metrics = resolveWebScrollMetrics();
                if (metrics && pendingWebPrependAnchorRef.current) {
                    pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
                        pendingWebPrependAnchorRef.current,
                        metrics,
                        resolvePendingWebPrependRefreshOptions(restoreResult.strategy),
                    );
                }
                pendingWebPrependIndexRecoveryRef.current = restoreResult.strategy === 'growth';
                if (restoreResult.strategy === 'growth') {
                    schedulePendingWebPrependIndexRecovery();
                }
            }

            if (result.status === 'no_more') {
                setHasMoreOlder(false);
            } else if (result.status === 'loaded' || result.status === 'not_ready' || result.status === 'in_flight') {
                setHasMoreOlder(result.hasMore);
            }
            return {
                loaded: result.loaded,
                hasMore: result.hasMore,
                status: result.status,
            };
        } finally {
            inFlightWebPrependAnchorRef.current = null;
            setIsLoadingOlder(false);
            loadOlderInFlight.current = false;
        }
    }, [
        captureCurrentWebPrependAnchor,
        hasMoreOlder,
        listImplementation,
        pinThresholdPx,
        props.committedMessagesCount,
        props.forkedTranscriptEnabled,
        props.isLoaded,
        props.sessionId,
        resolveWebScrollMetrics,
    ]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || listImplementation !== 'flash_v2') return;

        const pendingAnchor = pendingWebPrependAnchorRef.current;
        if (!pendingAnchor) return;
        if (pendingAnchor.userIntentAtMs !== lastUserScrollIntentAtMsRef.current) {
            pendingWebPrependAnchorRef.current = null;
            pendingWebPrependIndexRecoveryRef.current = false;
            return;
        }
        if (Date.now() > pendingAnchor.expiresAtMs) {
            pendingWebPrependAnchorRef.current = null;
            pendingWebPrependIndexRecoveryRef.current = false;
            return;
        }

        const restoreResult = restoreWebTranscriptPrependAnchor(pendingAnchor);
        const metrics = resolveWebScrollMetrics();
        if (!metrics) {
            pendingWebPrependAnchorRef.current = null;
            pendingWebPrependIndexRecoveryRef.current = false;
            return;
        }
        pendingWebPrependAnchorRef.current = refreshWebTranscriptPrependAnchor(
            pendingAnchor,
            metrics,
            resolvePendingWebPrependRefreshOptions(restoreResult.strategy),
        );
        pendingWebPrependIndexRecoveryRef.current =
            pendingWebPrependIndexRecoveryRef.current || restoreResult.strategy === 'growth';
        if (pendingWebPrependIndexRecoveryRef.current && pendingWebPrependAnchorRef.current) {
            attemptPendingWebPrependIndexRecovery();
        }
    }, [attemptPendingWebPrependIndexRecovery, listContentHeight, listData.length, listImplementation, props.sessionId, resolvePendingWebPrependRefreshOptions, resolveWebScrollMetrics]);

    const tryPinToBottomDom = React.useCallback((): boolean => {
        if (Platform.OS !== 'web') return false;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return false;

        const scrollToVisualBottom = listImplementation !== 'flatlist_legacy';
        try {
            (metrics.element as any).scrollTop = scrollToVisualBottom ? (metrics.element as any).scrollHeight : 0;
        } catch {
            try {
                (metrics.element as any).scrollTop = scrollToVisualBottom ? (metrics.element as any).scrollHeight : 0;
            } catch {
                return false;
            }
        }

        return true;
    }, [listImplementation, resolveWebScrollMetrics]);

    const pinToBottom = React.useCallback(() => {
        if (Platform.OS === 'web') {
            // Prefer DOM scroll writes on web: RNW list refs can apply delayed `scrollToOffset` that
            // fights against our pinning and results in visible drift/jitter.
            if (tryPinToBottomDom()) {
                return;
            }
            // If we cannot reliably locate a DOM scroll container yet, avoid falling back to the
            // list ref scroll APIs on web. Early `scrollToOffset({ offset: 0 })` calls can create
            // visible "scroll to top" jitter during mount while the real scroll container is still
            // being attached/measured.
            return;
        }
        const node: any = listRef.current as any;
        if (node && typeof node.scrollToOffset === 'function') {
            const offset =
                listImplementation === 'flatlist_legacy'
                    ? 0
                    : Math.max(0, Math.trunc(listContentHeightRef.current - listLayoutHeightRef.current));
            node.scrollToOffset({ offset, animated: false });
        }
    }, [listImplementation, tryPinToBottomDom]);

    const jumpToBottom = React.useCallback(() => {
        if (Platform.OS === 'web') {
            if (tryPinToBottomDom()) {
                isPinnedRef.current = true;
                wantsPinnedRef.current = true;
                setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
                return;
            }
        }
        const node: any = listRef.current as any;
        if (node && typeof node.scrollToOffset === 'function') {
            const offset =
                listImplementation === 'flatlist_legacy'
                    ? 0
                    : Math.max(0, Math.trunc(listContentHeightRef.current - listLayoutHeightRef.current));
            node.scrollToOffset({ offset, animated: jumpAnimateScroll });
        } else {
            pinToBottom();
        }
        isPinnedRef.current = true;
        wantsPinnedRef.current = true;
        setScrollPin((prev) => ({ ...prev, isPinned: true, newActivityCount: 0 }));
        if (Platform.OS === 'web') {
            tryPinToBottomDom();
        }
    }, [jumpAnimateScroll, listImplementation, pinToBottom, tryPinToBottomDom]);

    const shouldAutoPinToBottomNow = React.useCallback((): boolean => {
        if (!pinEnabled || !autoFollowWhenPinned) return false;
        if (props.jumpToSeq != null) return false;
        if (!wantsPinnedRef.current) return false;
        return Date.now() - lastUserScrollIntentAtMsRef.current >= 250;
    }, [autoFollowWhenPinned, pinEnabled, props.jumpToSeq]);

    const scheduledPinRef = React.useRef<{ kind: 'raf' | 'timeout'; id: any } | null>(null);
    const schedulePinToBottom = React.useCallback(() => {
        if (listImplementation !== 'flash_v2') return;
        if (!shouldAutoPinToBottomNow()) return;
        if (scheduledPinRef.current) return;

        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (typeof raf === 'function') {
            const handle: { kind: 'raf'; id: any } = { kind: 'raf', id: 0 };
            scheduledPinRef.current = handle;
            handle.id = raf(() => {
                if (scheduledPinRef.current !== handle) return;
                scheduledPinRef.current = null;
                if (!shouldAutoPinToBottomNow()) return;
                pinToBottom();
            });
            return;
        }

        const handle: { kind: 'timeout'; id: any } = { kind: 'timeout', id: null };
        scheduledPinRef.current = handle;
        handle.id = setTimeout(() => {
            if (scheduledPinRef.current !== handle) return;
            scheduledPinRef.current = null;
            if (!shouldAutoPinToBottomNow()) return;
            pinToBottom();
        }, 0);
    }, [listImplementation, pinToBottom, shouldAutoPinToBottomNow]);

    React.useEffect(() => {
        return () => {
            const scheduled = scheduledPinRef.current;
            if (!scheduled) return;
            scheduledPinRef.current = null;
            if (scheduled.kind === 'raf') {
                const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
                if (typeof caf === 'function') {
                    caf(scheduled.id);
                }
            } else {
                clearTimeout(scheduled.id);
            }
        };
    }, []);

    React.useLayoutEffect(() => {
        // When pinned, proactively keep the list at the visual bottom as new activity arrives.
        // This complements `maintainVisibleContentPosition`, especially on platforms where
        // inverted list anchoring can be inconsistent.
        if (pinEnabled && autoFollowWhenPinned && isPinnedRef.current && props.jumpToSeq == null) {
            pinToBottom();
        }
        setScrollPin((prev) =>
            reduceTranscriptScrollPinState({ ...prev, isPinned: isPinnedRef.current }, {
                type: 'newActivity',
                enabled: pinEnabled,
                activityKey: props.latestCommittedActivityKey,
            })
        );
    }, [autoFollowWhenPinned, pinEnabled, pinToBottom, props.jumpToSeq, props.latestCommittedActivityKey]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialPinSessionIdRef.current === props.sessionId) return;

        // Some platforms (especially web) can apply scroll anchoring / restoration
        // during the first render+layout ticks, resulting in the transcript appearing "scrolled up"
        // after a refresh. Pin immediately and then re-pin after a couple microtasks / a frame to
        // ensure the visual bottom stays stable.
        initialPinSessionIdRef.current = props.sessionId;
        let cancelled = false;

        const isSettledAtVisualBottom = () => {
            if (Platform.OS !== 'web') return false;
            const metrics = resolveWebScrollMetrics();
            if (!metrics) return false;
            return getWebTranscriptDistanceFromBottom(metrics) === 0;
        };

        const attempt = (): boolean => {
            if (cancelled) return true;
            // If the user is actively scrolling (or scroll inertia is still firing wheel events),
            // avoid fighting their intent with initial pin retries.
            if (Platform.OS === 'web') {
                if (wantsPinnedRef.current === false) {
                    initialWebPinStabilizingRef.current = false;
                    return true;
                }
                if (Date.now() - lastUserScrollIntentAtMsRef.current < 250) return false;
            }
            pinToBottom();
            if (Platform.OS === 'web' && isSettledAtVisualBottom()) {
                initialWebPinStabilizingRef.current = false;
                return true;
            }
            return false;
        };

        if (Platform.OS === 'web') {
            const tuning = sync.getSyncTuning();
            const stabilizeMaxMsRaw = tuning.transcriptWebInitialPinStabilizeMs;
            const retryIntervalMsRaw = tuning.transcriptWebInitialPinRetryIntervalMs;
            const stabilizeMaxMs =
                typeof stabilizeMaxMsRaw === 'number' && Number.isFinite(stabilizeMaxMsRaw)
                    ? Math.max(0, Math.trunc(stabilizeMaxMsRaw))
                    : 8000;
            const retryIntervalMs =
                typeof retryIntervalMsRaw === 'number' && Number.isFinite(retryIntervalMsRaw)
                    ? Math.max(16, Math.trunc(retryIntervalMsRaw))
                    : 250;

            if (attempt()) {
                return () => {
                    cancelled = true;
                    initialWebPinStabilizingRef.current = false;
                };
            }

            const delays = [0, 16, 50, 100, 200, 400, 800].filter((ms) => ms <= stabilizeMaxMs);
            if (stabilizeMaxMs >= 1000) {
                for (let ms = 1000; ms <= stabilizeMaxMs; ms += retryIntervalMs) {
                    delays.push(ms);
                }
            }

            if (delays.length === 0) {
                initialWebPinStabilizingRef.current = false;
                return () => {
                    cancelled = true;
                };
            }

            initialWebPinStabilizingRef.current = true;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            let delayIndex = 0;

            const scheduleNext = () => {
                if (cancelled) return;
                if (delayIndex >= delays.length) {
                    initialWebPinStabilizingRef.current = false;
                    return;
                }
                const delayMs = delays[delayIndex];
                delayIndex += 1;
                timeoutId = setTimeout(() => {
                    timeoutId = null;
                    if (attempt()) return;
                    scheduleNext();
                }, delayMs);
            };

            scheduleNext();
            return () => {
                cancelled = true;
                initialWebPinStabilizingRef.current = false;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            };
        }

        // Pin immediately and then re-pin during the first few ticks on native. This is defensive
        // against layout settling after the initial paint.
        attempt();
        void Promise.resolve().then(() => {
            void attempt();
        });
        void Promise.resolve().then(() => Promise.resolve()).then(() => {
            void attempt();
        });
        return () => { cancelled = true; };
    }, [pinToBottom, props.isLoaded, props.jumpToSeq, props.sessionId, resolveWebScrollMetrics]);

    const isScrollable = React.useCallback((): boolean => {
        // On web, list content height can include collapsed/offscreen subtrees (e.g. tool-call group bodies),
        // which can cause false positives. Prefer DOM scroll metrics when available.
        if (Platform.OS === 'web') {
            try {
                const metrics = resolveWebScrollMetrics();
                if (metrics) {
                    return isWebTranscriptScrollable(metrics, 1);
                }
            } catch {
                // fall through to measurement-based heuristic
            }
        }

        const layout = listLayoutHeight;
        const content = listContentHeight;
        if (!Number.isFinite(layout) || layout <= 0) return false;
        if (!Number.isFinite(content) || content <= 0) return false;
        return content > layout + 16;
    }, [listContentHeight, listLayoutHeight, resolveWebScrollMetrics]);

    const shouldLoadOlderFromStartReached = React.useCallback((): boolean => {
        if (initialFillStatusRef.current !== 'done') return false;
        if (listImplementation !== 'flash_v2' || Platform.OS !== 'web') return true;

        const prefetchThresholdPx = Math.max(1, listLayoutHeightRef.current * 0.2);
        const metrics = resolveWebScrollMetrics();
        if (metrics) {
            return shouldPrefetchOlderFromTop({
                scrollable: isWebTranscriptScrollable(metrics, 1),
                offsetY: metrics.scrollTop,
                prefetchThresholdPx,
                distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
                pinThresholdPx,
                wantsPinned: wantsPinnedRef.current,
            });
        }

        return wantsPinnedRef.current !== true;
    }, [listImplementation, pinThresholdPx, resolveWebScrollMetrics]);

    const resolveToolCallsCollapsedPreviewCount = React.useCallback((): number => {
        const raw = typeof transcriptToolCallsCollapsedPreviewCountSetting === 'number'
            ? transcriptToolCallsCollapsedPreviewCountSetting
            : 5;
        if (!Number.isFinite(raw)) return 5;
        return Math.max(0, Math.min(15, Math.trunc(raw)));
    }, [transcriptToolCallsCollapsedPreviewCountSetting]);

    const tryAutoExpandNewestToolCallsGroup = React.useCallback((): boolean => {
        const previewCount = resolveToolCallsCollapsedPreviewCount();
        const items = itemsRef.current;
        const newestFirst = listImplementation === 'flatlist_legacy';

        const visitItem = (it: ChatTranscriptListItem | null | undefined): boolean => {
            if (!it) return false;
            if (it.kind === 'tool-calls-group') {
                const toolMessageIds = it.toolMessageIds;
                if (toolMessageIds.length <= previewCount) return false;
                if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) return false;
                setToolCallsGroupExpanded({ toolCallsGroupId: it.id, toolMessageIds, expanded: true });
                return true;
            }
            if (it.kind === 'turn') {
                const content = it.turn?.content;
                if (!Array.isArray(content) || content.length === 0) return false;
                for (let j = content.length - 1; j >= 0; j -= 1) {
                    const c = content[j];
                    if (c.kind !== 'tool_calls') continue;
                    const toolMessageIds = c.toolMessageIds;
                    if (toolMessageIds.length <= previewCount) continue;
                    if (toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))) continue;
                    setToolCallsGroupExpanded({ toolCallsGroupId: c.id, toolMessageIds, expanded: true });
                    return true;
                }
            }
            return false;
        };

        if (newestFirst) {
            for (let i = 0; i < items.length; i += 1) {
                if (visitItem(items[i])) return true;
            }
            return false;
        }
        for (let i = items.length - 1; i >= 0; i -= 1) {
            if (visitItem(items[i])) return true;
        }
        return false;
    }, [expandedToolCallsAnchorMessageIds, listImplementation, resolveToolCallsCollapsedPreviewCount, setToolCallsGroupExpanded]);

    React.useEffect(() => {
        // Intentionally runs after every render until the transcript becomes scrollable or we succeed.
        // The turns/grouping builder can update in-place as message bodies hydrate, so relying on
        // `items`/`listData` identity is not robust here.
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (didAutoExpandToolCallsGroupsForSessionRef.current === props.sessionId) return;
        if (isScrollable()) return;

        const expanded = tryAutoExpandNewestToolCallsGroup();
        if (!expanded) return;

        didAutoExpandToolCallsGroupsForSessionRef.current = props.sessionId;
        fireAndForget((async () => {
            await Promise.resolve();
            await Promise.resolve();
            pinToBottom();
        })(), { tag: 'ChatList.autoExpandToolCallsGroup' });
    });

    const resolveJumpIndex = React.useCallback((): number | null => {
        const target = props.jumpToSeq;
        if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return null;

        let exact: number | null = null;
        let nextAfter: { idx: number; seq: number } | null = null;
        let prevBefore: { idx: number; seq: number } | null = null;
        const items = itemsRef.current;

        const considerSeq = (idx: number, seq: number) => {
            const normalizedSeq = Math.trunc(seq);
            if (normalizedSeq === target) {
                exact = idx;
                return;
            }
            if (normalizedSeq > target) {
                if (!nextAfter || normalizedSeq < nextAfter.seq) nextAfter = { idx, seq: normalizedSeq };
            } else if (normalizedSeq < target) {
                if (!prevBefore || normalizedSeq > prevBefore.seq) prevBefore = { idx, seq: normalizedSeq };
            }
        };

        for (let i = 0; i < items.length; i++) {
            const it = items[i]!;
            if (it.kind === 'message') {
                const seq = it.seq ?? resolveSeqForMessageId(it.messageId);
                if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
            } else if (it.kind === 'turn') {
                const userSeq = it.turn.userMessageId ? resolveSeqForMessageId(it.turn.userMessageId) : null;
                if (typeof userSeq === 'number' && Number.isFinite(userSeq)) considerSeq(i, userSeq);
                for (const c of it.turn.content) {
                    if (c.kind === 'message') {
                        const seq = resolveSeqForMessageId(c.messageId);
                        if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
                    } else if (c.kind === 'tool_calls') {
                        for (const toolMessageId of c.toolMessageIds) {
                            const seq = resolveSeqForMessageId(toolMessageId);
                            if (typeof seq === 'number' && Number.isFinite(seq)) considerSeq(i, seq);
                        }
                    }
                    if (exact != null) break;
                }
            }
            if (exact != null) break;
        }
        if (exact != null) return exact;
        if (nextAfter) return nextAfter.idx;
        if (prevBefore) return prevBefore.idx;
        return null;
    }, [props.jumpToSeq, resolveSeqForMessageId]);

    React.useEffect(() => {
        const target = props.jumpToSeq;
        if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return;
        if (!props.isLoaded) return;
        if (lastJumpSeqRef.current === target) return;
        if (!props.sessionId) return;

        lastJumpSeqRef.current = target;
        fireAndForget((async () => {
            await jumpToTranscriptSeq({
                targetSeq: target,
                getIndex: resolveJumpIndex,
                loadOlder: async () => {
                    const result = props.forkedTranscriptEnabled
                        ? await sync.loadOlderMessagesForkAware(props.sessionId)
                        : await sync.loadOlderMessages(props.sessionId);
                    if (result.status === 'no_more') return { status: 'no_more' as const };
                    return { status: 'loaded' as const, hasMore: result.hasMore };
                },
                afterLoadOlder: async () => {
                    // Yield to allow store updates + list re-render before re-checking `getIndex`.
                    await Promise.resolve();
                    await Promise.resolve();
                },
                scrollToIndex: (index) => {
                    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
                },
                maxLoads: 25,
            });
        })(), { tag: 'ChatList.jumpToTranscriptSeq' });
    }, [props.isLoaded, props.jumpToSeq, props.sessionId, resolveJumpIndex]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialFillStatusRef.current !== 'idle') return;

        // Wait for at least one layout + content measurement pass before deciding whether to fill.
        if (listLayoutHeight <= 0 || listContentHeight <= 0) return;

        initialFillStatusRef.current = 'in_progress';
        initialFillAbortRef.current?.abort();
        const controller = new AbortController();
        initialFillAbortRef.current = controller;
        const signal = controller.signal;
        fireAndForget((async () => {
            // Always pin once up front; this protects against initial layout anchoring quirks on web.
            pinToBottom();
            if (Platform.OS === 'web') {
                await waitForNextVisualUpdate();
            }

            const tuning = sync.getSyncTuning();
            const startedAtMs = Date.now();
            const budgetMs = tuning.transcriptInitialFillBudgetMs;
            const maxNoProgressLoads = tuning.transcriptInitialFillMaxNoProgressLoads;
            let consecutiveNoProgressLoads = 0;

            while (true) {
                if (signal.aborted) return;
                // If the transcript is scrollable and we have at least one visible committed message,
                // stop prefetching older pages.
                if (isScrollable() && props.committedMessagesCount > 0) break;
                if (Date.now() - startedAtMs >= budgetMs) break;

                const result = await loadOlder();
                if (!result) break;
                if (result.status === 'no_more') break;

                const madeProgress = result.status === 'loaded' && result.loaded > 0;
                consecutiveNoProgressLoads = madeProgress ? 0 : consecutiveNoProgressLoads + 1;

                // Yield to allow store updates + list re-render + content size update.
                await Promise.resolve();
                await Promise.resolve();
                pinToBottom();
                if (consecutiveNoProgressLoads >= maxNoProgressLoads) break;
            }
            if (signal.aborted) return;
            initialFillStatusRef.current = 'done';
        })(), { tag: 'ChatList.initialFillOlderMessages' });
    }, [
        isScrollable,
        listContentHeight,
        listLayoutHeight,
        loadOlder,
        pinToBottom,
        props.committedMessagesCount,
        props.isLoaded,
        props.jumpToSeq,
        props.sessionId,
        waitForNextVisualUpdate,
    ]);

    return (
        <TranscriptMotionProvider sessionKey={props.sessionId} config={motionConfig}>
            <View
              style={{ flex: 1 }}
              {...(Platform.OS === 'web'
                ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                : {})}
            >
          {listImplementation === 'flatlist_legacy' ? (
          <FlatList<ChatTranscriptListItem>
          ref={(node) => {
            // react-test-renderer does not provide a stable ref object; we store it manually.
            listRef.current = node as unknown as ScrollableChatListRef | null;
          }}
            {...(Platform.OS === 'web'
              ? ({
                                    onWheel: stopScrollEventPropagationOnWeb,
                                    onTouchMove: stopScrollEventPropagationOnWeb,
                                    onPointerDown: markUserScrollIntentOnWeb,
                                    onMouseDown: markUserScrollIntentOnWeb,
                              } as any)
              : {})}
          testID="transcript-chat-list"
          data={listData}
          inverted={true}
          nativeID={chatListNativeId}
                  keyExtractor={keyExtractor}
          maintainVisibleContentPosition={
                        flatListMaintainVisibleContentPosition
                      }
                onLayout={(e) => {
                    const h = e?.nativeEvent?.layout?.height;
                    if (typeof h === 'number' && Number.isFinite(h)) {
                        listLayoutHeightRef.current = h;
                        setListLayoutHeight(h);
                    }
                }}
                onContentSizeChange={(_, h) => {
                    if (typeof h === 'number' && Number.isFinite(h)) {
                        listContentHeightRef.current = h;
                        setListContentHeight(h);
                    }
                }}
                  onScroll={(e) => {
                      const y = e?.nativeEvent?.contentOffset?.y;
                      if (typeof y !== 'number' || !Number.isFinite(y)) return;
                          const nowMs = Date.now();
                        const isTrusted = (e as any)?.nativeEvent?.isTrusted === true;
                        if (isTrusted) {
                            lastUserScrollIntentAtMsRef.current = nowMs;
                        }
                        const distanceFromBottom = Math.max(0, Math.trunc(y));
                        const prev = lastPinOffsetForIntentRef.current;
                        const movedAwayFromBottom = typeof prev === 'number' ? distanceFromBottom > prev : false;
                        lastPinOffsetForIntentRef.current = distanceFromBottom;

                        // Only re-enable pin intent when the user returns to the exact bottom. Staying within
                        // the threshold does not imply intent (it can be a deliberate small scroll).
                          if (distanceFromBottom === 0) {
                              wantsPinnedRef.current = true;
                          } else {
                              const recentlyUserIntent =
                                    isTrusted || nowMs - lastUserScrollIntentAtMsRef.current < 500;
                              if (recentlyUserIntent && movedAwayFromBottom) {
                                  wantsPinnedRef.current = false;
                              }
                          }

                        const effectiveThresholdPx = wantsPinnedRef.current ? pinThresholdPx : 0;
                      const pinned = distanceFromBottom <= effectiveThresholdPx;
                        if (
                            !pinned &&
                            wantsPinnedRef.current &&
                            pinEnabled &&
                            autoFollowWhenPinned &&
                            props.jumpToSeq == null &&
                            Platform.OS !== 'web' &&
                            nowMs - lastAutoRepinAtMsRef.current > 200 &&
                            nowMs - lastUserScrollIntentAtMsRef.current >= 250
                        ) {
                            // Web/virtualization can sometimes drift the scroll position even without user intent.
                            // If we still "want pinned", repin opportunistically.
                            lastAutoRepinAtMsRef.current = nowMs;
                            pinToBottom();
                        }
                      isPinnedRef.current = pinned;
                      props.onViewportChange?.({ isPinned: pinned, offsetY: distanceFromBottom });
                    setScrollPin((prev) =>
                        reduceTranscriptScrollPinState(prev, {
                            type: 'scroll',
                            enabled: pinEnabled,
                            offsetY: distanceFromBottom,
                            pinnedOffsetThresholdPx: effectiveThresholdPx,
                        })
                    );

                    const prefetchThresholdPx = sync.getSyncTuning().transcriptForwardPrefetchThresholdPx;
                    if (!pinned && distanceFromBottom <= prefetchThresholdPx && !loadNewerInFlight.current) {
                        if (sync.hasDeferredNewerMessages(props.sessionId) === true) {
                            loadNewerInFlight.current = true;
                            const p = sync.loadNewerMessages(props.sessionId);
                            p.finally(() => {
                                loadNewerInFlight.current = false;
                            }).catch(() => {});
                            fireAndForget(p, { tag: 'ChatList.loadNewerMessages' });
                        }
                    }
                }}
                onScrollBeginDrag={() => {
                    if (Platform.OS === 'web') return;
                    lastUserScrollIntentAtMsRef.current = Date.now();
                }}
                scrollEventThrottle={16}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                renderItem={renderItem}
                onEndReachedThreshold={0.2}
                onEndReached={() => {
                    if (initialFillStatusRef.current !== 'done') return;
                    void loadOlder();
                }}
                onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
                    // Best-effort fallback for dynamic-height rows.
                    const offset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
                    listRef.current?.scrollToOffset({ offset, animated: true });
                }}
                  ListHeaderComponent={
                        <ListHeader isLoadingOlder={isLoadingOlder} />
                  }
                  ListFooterComponent={
                        listFooterNode
                    }
              />
              ) : (
                  <FlashList
                      ref={(node: ScrollableChatListRef | null) => {
                          listRef.current = node as unknown as ScrollableChatListRef | null;
                      }}
                        {...(Platform.OS === 'web'
                            ? ({
                                        onWheel: stopScrollEventPropagationOnWeb,
                                        onTouchMove: stopScrollEventPropagationOnWeb,
                                        onPointerDown: markUserScrollIntentOnWeb,
                                        onMouseDown: markUserScrollIntentOnWeb,
                                  } as any)
                            : {})}
                        testID="transcript-chat-list"
                      data={listData}
                      nativeID={chatListNativeId}
                      keyExtractor={keyExtractor}
                        getItemType={getItemType}
                      maintainVisibleContentPosition={
                          flashListMaintainVisibleContentPosition
                      }
                      onLayout={(e: LayoutChangeEvent) => {
                          const h = e?.nativeEvent?.layout?.height;
                          if (typeof h === 'number' && Number.isFinite(h)) {
                              listLayoutHeightRef.current = h;
                              setListLayoutHeight(h);
                                if (listContentHeightRef.current > 0) {
                                    schedulePinToBottom();
                                }
                          }
                      }}
                      onContentSizeChange={(_: number, h: number) => {
                          if (typeof h === 'number' && Number.isFinite(h)) {
                              listContentHeightRef.current = h;
                              setListContentHeight(h);
                                if (listLayoutHeightRef.current > 0) {
                                    schedulePinToBottom();
                                }
                          }
                      }}
                        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                            const y = e?.nativeEvent?.contentOffset?.y;
                            if (typeof y !== 'number' || !Number.isFinite(y)) return;
                                const nowMs = Date.now();
                                const isTrusted = (e as any)?.nativeEvent?.isTrusted === true;
                                if (isTrusted) {
                                    lastUserScrollIntentAtMsRef.current = nowMs;
                                }
                              const layoutH = listLayoutHeightRef.current;
                              const contentH = listContentHeightRef.current;
                              const distanceFromBottom =
                                  layoutH > 0 && contentH >= layoutH
                                      ? Math.max(0, Math.trunc(contentH - layoutH - y))
                                      : 0;
                                const backwardPrefetchThresholdPx = sync.getSyncTuning().transcriptBackwardPrefetchThresholdPx;
                                const scrollable = layoutH > 0 && contentH > layoutH + 16;
                                if (shouldPrefetchOlderFromTop({
                                    scrollable: initialFillStatusRef.current === 'done' && scrollable,
                                    offsetY: y,
                                    prefetchThresholdPx: backwardPrefetchThresholdPx,
                                    distanceFromBottom,
                                    pinThresholdPx,
                                    wantsPinned: wantsPinnedRef.current,
                                })) {
                                    void loadOlder();
                                }
                                if (loadOlderInFlight.current) {
                                    refreshInFlightWebPrependAnchor();
                                }
                                const prev = lastPinOffsetForIntentRef.current;
                                const movedAwayFromBottom = typeof prev === 'number' ? distanceFromBottom > prev : false;
                                lastPinOffsetForIntentRef.current = distanceFromBottom;

                                if (distanceFromBottom === 0) {
                                    wantsPinnedRef.current = true;
                                } else {
                                    const recentlyUserIntent =
                                            isTrusted || nowMs - lastUserScrollIntentAtMsRef.current < 500;
                                    if (recentlyUserIntent && movedAwayFromBottom) {
                                        wantsPinnedRef.current = false;
                                    }
                                }

                              const effectiveThresholdPx = wantsPinnedRef.current ? pinThresholdPx : 0;
                            const pinned = distanceFromBottom <= effectiveThresholdPx;
                              if (
                                  !pinned &&
                                  wantsPinnedRef.current &&
                                  pinEnabled &&
                                  autoFollowWhenPinned &&
                                  props.jumpToSeq == null &&
                                  Platform.OS !== 'web' &&
                                  nowMs - lastAutoRepinAtMsRef.current > 200 &&
                                  nowMs - lastUserScrollIntentAtMsRef.current >= 250
                              ) {
                                  lastAutoRepinAtMsRef.current = nowMs;
                                  pinToBottom();
                              }
                              isPinnedRef.current = pinned;
                              props.onViewportChange?.({ isPinned: pinned, offsetY: distanceFromBottom });
                          setScrollPin((prev) =>
                              reduceTranscriptScrollPinState(prev, {
                                  type: 'scroll',
                                  enabled: pinEnabled,
                                  offsetY: distanceFromBottom,
                                  pinnedOffsetThresholdPx: effectiveThresholdPx,
                              })
                          );

                          const prefetchThresholdPx = sync.getSyncTuning().transcriptForwardPrefetchThresholdPx;
                          if (!pinned && distanceFromBottom <= prefetchThresholdPx && !loadNewerInFlight.current) {
                              if (sync.hasDeferredNewerMessages(props.sessionId) === true) {
                                  loadNewerInFlight.current = true;
                                  const p = sync.loadNewerMessages(props.sessionId);
                                  p.finally(() => {
                                      loadNewerInFlight.current = false;
                                  }).catch(() => {});
                                  fireAndForget(p, { tag: 'ChatList.loadNewerMessages' });
                              }
                          }
                      }}
                        onScrollBeginDrag={() => {
                            if (Platform.OS === 'web') return;
                            lastUserScrollIntentAtMsRef.current = Date.now();
                        }}
                      scrollEventThrottle={16}
                      keyboardShouldPersistTaps="handled"
                      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
                      renderItem={renderItem}
                      onStartReachedThreshold={0.2}
                      onStartReached={() => {
                          if (!shouldLoadOlderFromStartReached()) return;
                          void loadOlder();
                      }}
                      onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
                          const offset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
                          listRef.current?.scrollToOffset({ offset, animated: true });
                      }}
                      ListHeaderComponent={
                            <ListHeader isLoadingOlder={isLoadingOlder} />
                      }
                      ListFooterComponent={
                            flashListFooterNode
                        }
                  />
              )}
              {jumpEnabled && !scrollPin.isPinned && scrollPin.newActivityCount >= jumpMinNewCount ? (
                  <View style={{ position: 'absolute', right: 12, bottom: 12 }}>
                      <JumpToBottomButton
                          testID="transcript-jump-to-bottom"
                          count={scrollPin.newActivityCount}
                          onPress={jumpToBottom}
                    />
                </View>
            ) : null}
            </View>
        </TranscriptMotionProvider>
    )
});
