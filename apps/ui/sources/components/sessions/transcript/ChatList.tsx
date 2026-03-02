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
} from "@/sync/domains/state/storage";
import { ActivityIndicator, FlatList, Platform, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { ChatFooter } from './ChatFooter';
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
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { deriveTranscriptInteraction, type TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

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
    onRequestSwitchToRemote?: () => void;
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

    const messageIdsOldestFirst = forkedTranscriptEnabled ? (fork!.combinedMessageIdsOldestFirst as any as string[]) : childMessageIdsOldestFirst;
    const messagesById = forkedTranscriptEnabled ? (fork!.combinedMessagesById as any) : childMessagesById;

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
            latestThinkingMessageActivityAtMs,
            nowMs: thinkingPulseNow,
            staleMs,
        });
    }, [latestThinkingMessageActivityAtMs, latestThinkingMessageId, props.session.thinking, staleMs, thinkingPulseNow]);

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
            committedMessagesCount={messageIdsOldestFirst.length}
            latestCommittedActivityKey={latestCommittedActivityKey}
            activeThinkingMessageId={activeThinkingMessageId}
            isLoaded={isLoaded}
            bottomNotice={props.bottomNotice}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
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
    onRequestSwitchToRemote?: () => void;
}) => {
    const session = useSession(props.sessionId);
    if (!session) {
        return null;
    }
    const permissionsInUiWhileLocal = getPermissionsInUiWhileLocal(session.agentState?.capabilities);
    return (
        <ChatFooter
            controlledByUser={session.agentState?.controlledByUser || false}
            permissionsInUiWhileLocal={permissionsInUiWhileLocal}
            notice={props.bottomNotice ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
        />
    )
});

const ChatListMessageRow = React.memo(function ChatListMessageRow(props: {
    sessionId: string;
    messageId: string;
    originSessionId?: string;
    isReadOnlyContext?: boolean;
    metadata: Metadata | null;
    activeThinkingMessageId: string | null;
    resolveThinkingExpanded: (messageId: string) => boolean;
    setThinkingExpanded: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
}) {
    const originSessionId = props.originSessionId ?? props.sessionId;
    const message = useMessage(originSessionId, props.messageId);
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
        <View testID={`transcript-message-${props.messageId}`}>
            <MessageView
                message={message}
                metadata={props.metadata}
                sessionId={originSessionId}
                activeThinkingMessageId={props.activeThinkingMessageId}
                thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
                onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
                interaction={readOnlyInteraction}
            />
        </View>
    );
});

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    sessionSeq: number,
    forkedTranscriptEnabled: boolean,
    items: ChatTranscriptListItem[],
    committedMessagesCount: number,
    latestCommittedActivityKey: string | null,
    activeThinkingMessageId: string | null,
    isLoaded: boolean,
    bottomNotice?: ChatListBottomNotice | null,
    onRequestSwitchToRemote?: () => void,
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
    const chatListNativeId = React.useMemo(() => `ChatList.${props.sessionId}`, [props.sessionId]);
    const loadNewerInFlight = React.useRef(false);
    const webScrollContainerRef = React.useRef<HTMLElement | null>(null);
      const wantsPinnedRef = React.useRef(true);
      const lastUserScrollIntentAtMsRef = React.useRef(0);
      const lastAutoRepinAtMsRef = React.useRef(0);
      const lastPinOffsetForIntentRef = React.useRef<number | null>(null);

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

      const [scrollPin, setScrollPin] = React.useState<TranscriptScrollPinState>({
          isPinned: true,
          newActivityCount: 0,
          lastActivityKey: null,
      });
      const isPinnedRef = React.useRef(true);
      const [expandedToolCallsGroupIds, setExpandedToolCallsGroupIds] = React.useState<ReadonlySet<string>>(
          () => new Set<string>(),
      );
        const thinkingDefaultExpanded =
            sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
        const [thinkingExpandedByMessageId, setThinkingExpandedByMessageId] = React.useState<ReadonlyMap<string, boolean>>(
            () => new Map<string, boolean>(),
        );

      const setToolCallsGroupExpanded = React.useCallback((toolCallsGroupId: string, expanded: boolean) => {
          setExpandedToolCallsGroupIds((prev) => {
              const next = new Set(prev);
              if (expanded) {
                  next.add(toolCallsGroupId);
              } else {
                  next.delete(toolCallsGroupId);
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
    const [webFlashListCrashed, setWebFlashListCrashed] = React.useState(false);
    const listImplementation =
        Platform.OS === 'web' && preferredListImplementation === 'flash_v2' && webFlashListCrashed
            ? 'flatlist_legacy'
            : preferredListImplementation;

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (preferredListImplementation !== 'flash_v2') return;
        if (webFlashListCrashed) return;
        const win = (globalThis as any)?.window as undefined | { addEventListener?: any; removeEventListener?: any };
        if (!win || typeof win.addEventListener !== 'function' || typeof win.removeEventListener !== 'function') return;

        const shouldFallback = (message: string): boolean => {
            const text = (message ?? '').toLowerCase();
            if (!text) return false;
            return text.includes('not enough layouts') || text.includes('index out of bounds');
        };

        const onError = (event: any) => {
            const message = String(event?.error?.message ?? event?.message ?? '');
            if (!shouldFallback(message)) return;
            try {
                event?.preventDefault?.();
            } catch {
                // ignore
            }
            try {
                event?.stopImmediatePropagation?.();
            } catch {
                // ignore
            }
            setWebFlashListCrashed(true);
        };

        win.addEventListener('error', onError, true);
        return () => {
            try {
                win.removeEventListener('error', onError, true);
            } catch {
                // ignore
            }
        };
    }, [preferredListImplementation, webFlashListCrashed]);
    const listData = React.useMemo(() => {
        if (listImplementation === 'flatlist_legacy') {
            // Legacy: inverted lists expect newest-first input.
            return [...props.items].reverse();
        }
        return props.items;
    }, [listImplementation, props.items]);

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

    React.useEffect(() => {
        itemsRef.current = listData;
    }, [listData]);

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

    const toolTimelineChromeMode = useSetting('toolViewTimelineChromeMode');
    const keyExtractor = useCallback((item: ChatTranscriptListItem) => item.id, []);
    const getItemType = useCallback((item: ChatTranscriptListItem): string => item.kind, []);
      const renderItem = useCallback(({ item, index }: { item: ChatTranscriptListItem; index: number }) => {
          if (item.kind === 'action-draft') {
              return <SessionActionDraftCard sessionId={props.sessionId} draft={item.draft} />;
          }
        if (item.kind === 'fork-divider') {
            return (
                <TranscriptEnterWrapper id={item.id} createdAt={0}>
                    <ForkDividerRow
                        parentSessionId={item.parentSessionId}
                        childSessionId={item.childSessionId}
                        parentCutoffSeqInclusive={item.parentCutoffSeqInclusive}
                    />
                </TranscriptEnterWrapper>
            );
        }
        if (item.kind === 'pending-queue') {
            const createdAt = item.pendingMessages[0]?.createdAt ?? item.discardedMessages[0]?.createdAt ?? 0;
            return (
                <TranscriptEnterWrapper id={item.id} createdAt={createdAt}>
                    <PendingMessagesTranscriptBlock
                        sessionId={props.sessionId}
                        pendingMessages={item.pendingMessages}
                        discardedMessages={item.discardedMessages}
                    />
                </TranscriptEnterWrapper>
            );
        }
        if (item.kind === 'tool-calls-group') {
            return (
                <ToolCallsGroupRow
                    sessionId={props.sessionId}
                    toolCallsGroupId={item.id}
                    toolMessageIds={item.toolMessageIds}
                    metadata={props.metadata}
                    expanded={expandedToolCallsGroupIds.has(item.id)}
                    setExpanded={(expanded) => setToolCallsGroupExpanded(item.id, expanded)}
                    interaction={props.interaction}
                />
            );
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
            return (
                <TranscriptEnterWrapper id={item.id} createdAt={turnCreatedAt}>
                      <TurnView
                          turn={item.turn}
                          metadata={props.metadata}
                          sessionId={props.sessionId}
                          interaction={props.interaction}
                          activeThinkingMessageId={props.activeThinkingMessageId}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                          expandedToolCallsGroupIds={expandedToolCallsGroupIds}
                          setToolCallsGroupExpanded={setToolCallsGroupExpanded}
                      />
                  </TranscriptEnterWrapper>
              );
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

            return (
                <TranscriptEnterWrapper id={item.id} createdAt={item.createdAt}>
                    <View style={wrapperStyle}>
                        <ChatListMessageRow
                            sessionId={props.sessionId}
                            messageId={item.messageId}
                            originSessionId={item.originSessionId}
                            isReadOnlyContext={item.isReadOnlyContext}
                            metadata={props.metadata}
                            activeThinkingMessageId={props.activeThinkingMessageId}
                            resolveThinkingExpanded={resolveThinkingExpanded}
                            setThinkingExpanded={setThinkingExpanded}
                            interaction={props.interaction}
                        />
                    </View>
                </TranscriptEnterWrapper>
            );
        }
        return null;
      }, [expandedToolCallsGroupIds, listImplementation, props.activeThinkingMessageId, props.interaction, props.metadata, props.sessionId, resolveCreatedAtForMessageId, resolveKindForMessageId, resolveThinkingExpanded, setThinkingExpanded, setToolCallsGroupExpanded, toolTimelineChromeMode]);

    const loadOlder = useCallback(async (): Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null> => {
        if (!props.isLoaded) return null;
        // If the server has never emitted any committed transcript seq, pagination is a no-op.
        // IMPORTANT: committedMessagesCount can be 0 even when sessionSeq > 0 (e.g. sidechain-only newest page).
        if (!props.forkedTranscriptEnabled && (props.sessionSeq ?? 0) <= 0) return null;
        if (loadOlderInFlight.current || hasMoreOlder === false) {
            return null;
        }
        loadOlderInFlight.current = true;
        setIsLoadingOlder(true);
        try {
            const result = props.forkedTranscriptEnabled
                ? await sync.loadOlderMessagesForkAware(props.sessionId)
                : await sync.loadOlderMessages(props.sessionId);
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
            setIsLoadingOlder(false);
            loadOlderInFlight.current = false;
        }
    }, [props.forkedTranscriptEnabled, props.isLoaded, props.committedMessagesCount, props.sessionId, hasMoreOlder]);

    const tryPinToBottomDom = React.useCallback((): boolean => {
        if (Platform.OS !== 'web') return false;
        if (typeof document === 'undefined') return false;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;

        const isScrollable = (el: HTMLElement): boolean => {
            try {
                const cs = window.getComputedStyle(el);
                const overflowY = cs?.overflowY;
                if (!(overflowY === 'auto' || overflowY === 'scroll')) return false;
                const sh = (el as any).scrollHeight;
                const ch = (el as any).clientHeight;
                if (typeof sh !== 'number' || typeof ch !== 'number') return false;
                return sh > ch + 50;
            } catch {
                return false;
            }
        };

        const root = (document as any)?.getElementById?.(chatListNativeId) as HTMLElement | null | undefined;
        if (!root) return false;

        // NOTE: Multiple transcript screens can temporarily exist in the DOM on web (router transitions,
        // cached screens). Always scope pinning to the current session's `nativeID` subtree so we never
        // accidentally pin a stale/hidden list.
        if (isScrollable(root)) {
            webScrollContainerRef.current = root;
            const scrollToVisualBottom = listImplementation !== 'flatlist_legacy';
            try {
                (root as any).scrollTop = scrollToVisualBottom ? (root as any).scrollHeight : 0;
                return true;
            } catch {
                // Fall through to discovery.
            }
        }

        const cached = webScrollContainerRef.current;
        if (
            cached &&
            (cached as any).isConnected !== false &&
            typeof (root as any).contains === 'function' &&
            (root as any).contains(cached) &&
            isScrollable(cached)
        ) {
            const scrollToVisualBottom = listImplementation !== 'flatlist_legacy';
            try {
                // Prefer direct `scrollTop` writes: on RNW, ScrollView can override `scrollTo` with an
                // RN-style signature ({ x, y, animated }) which does NOT accept DOM-style { top } args.
                (cached as any).scrollTop = scrollToVisualBottom ? (cached as any).scrollHeight : 0;
                return true;
            } catch {
                // Fall through to re-discovery.
            }
        }

        const candidates: HTMLElement[] = [root];
        try {
            const desc = root.querySelectorAll?.('*') as NodeListOf<HTMLElement> | undefined;
            if (desc) candidates.push(...Array.from(desc));
        } catch {
            // ignore
        }

        let best: HTMLElement | null = null;
        let bestScrollHeight = 0;
        for (const el of candidates) {
            if (!isScrollable(el)) continue;
            const sh = (el as any).scrollHeight as number;
            if (!best || sh > bestScrollHeight) {
                best = el;
                bestScrollHeight = sh;
            }
        }

        // If we couldn't find a scroll container inside the root, fall back to ancestors.
        if (!best) {
            let el: HTMLElement | null = root.parentElement;
            let steps = 0;
            while (el && steps < 30) {
                if (isScrollable(el)) {
                    best = el;
                    break;
                }
                el = el.parentElement;
                steps++;
            }
        }

        if (!best) return false;
        webScrollContainerRef.current = best;

        const scrollToVisualBottom = listImplementation !== 'flatlist_legacy';
        try {
            (best as any).scrollTop = scrollToVisualBottom ? (best as any).scrollHeight : 0;
        } catch {
            try {
                (best as any).scrollTop = scrollToVisualBottom ? (best as any).scrollHeight : 0;
            } catch {
                return false;
            }
        }

        return true;
    }, [chatListNativeId, listImplementation]);

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

    const scheduledPinRef = React.useRef<{ kind: 'raf' | 'timeout'; id: any } | null>(null);
    const schedulePinToBottom = React.useCallback(() => {
        if (listImplementation !== 'flash_v2') return;
        if (!pinEnabled || !autoFollowWhenPinned) return;
        if (props.jumpToSeq != null) return;
        if (!wantsPinnedRef.current) return;
        // Avoid fighting recent user scroll intent.
        if (Date.now() - lastUserScrollIntentAtMsRef.current < 250) return;
        if (scheduledPinRef.current) return;

        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (typeof raf === 'function') {
            const handle: { kind: 'raf'; id: any } = { kind: 'raf', id: 0 };
            scheduledPinRef.current = handle;
            handle.id = raf(() => {
                if (scheduledPinRef.current !== handle) return;
                scheduledPinRef.current = null;
                pinToBottom();
            });
            return;
        }

        const handle: { kind: 'timeout'; id: any } = { kind: 'timeout', id: null };
        scheduledPinRef.current = handle;
        handle.id = setTimeout(() => {
            if (scheduledPinRef.current !== handle) return;
            scheduledPinRef.current = null;
            pinToBottom();
        }, 0);
    }, [autoFollowWhenPinned, listImplementation, pinEnabled, pinToBottom, props.jumpToSeq]);

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

        const attempt = () => {
            if (cancelled) return;
            // If the user is actively scrolling (or scroll inertia is still firing wheel events),
            // avoid fighting their intent with initial pin retries.
            if (Platform.OS === 'web') {
                if (wantsPinnedRef.current === false) return;
                if (Date.now() - lastUserScrollIntentAtMsRef.current < 250) return;
            }
            pinToBottom();
        };

        // Pin immediately and then re-pin during the first few ticks. This is defensive against
        // web scroll anchoring / restoration that can happen after the initial paint.
        attempt();
        void Promise.resolve().then(attempt);
        void Promise.resolve().then(() => Promise.resolve()).then(attempt);
        if (Platform.OS === 'web') {
            const timeouts: any[] = [];
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(attempt);
                requestAnimationFrame(() => requestAnimationFrame(attempt));
            }
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

            for (const ms of [0, 16, 50, 100, 200, 400, 800]) {
                timeouts.push(setTimeout(attempt, ms));
            }
            if (stabilizeMaxMs >= 1000) {
                for (let ms = 1000; ms <= stabilizeMaxMs; ms += retryIntervalMs) {
                    timeouts.push(setTimeout(attempt, ms));
                }
            }
            return () => {
                cancelled = true;
                for (const t of timeouts) clearTimeout(t);
            };
        }

        return () => { cancelled = true; };
    }, [pinToBottom, props.isLoaded, props.jumpToSeq, props.sessionId]);

    const isScrollable = React.useCallback((): boolean => {
        const layout = listLayoutHeight;
        const content = listContentHeight;
        if (!Number.isFinite(layout) || layout <= 0) return false;
        if (!Number.isFinite(content) || content <= 0) return false;
        return content > layout + 16;
    }, [listContentHeight, listLayoutHeight]);

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
        if (!props.forkedTranscriptEnabled && (props.sessionSeq ?? 0) <= 0) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialFillStatusRef.current !== 'idle') return;

        // Wait for at least one layout + content measurement pass before deciding whether to fill.
        if (listLayoutHeight <= 0 || listContentHeight <= 0) return;

        initialFillStatusRef.current = 'in_progress';
        let cancelled = false;
        fireAndForget((async () => {
            // Always pin once up front; this protects against initial layout anchoring quirks on web.
            pinToBottom();

            const maxLoads = 10;
            for (let i = 0; i < maxLoads; i++) {
                if (cancelled) return;
                // If the transcript is scrollable and we have at least one visible committed message,
                // stop prefetching older pages.
                if (isScrollable() && props.committedMessagesCount > 0) break;

                const result = await loadOlder();
                if (!result) break;
                if (result.status === 'no_more') break;

                // Yield to allow store updates + list re-render + content size update.
                await Promise.resolve();
                await Promise.resolve();
                pinToBottom();
            }
            if (cancelled) return;
            initialFillStatusRef.current = 'done';
        })(), { tag: 'ChatList.initialFillOlderMessages' });

        return () => { cancelled = true; };
    }, [isScrollable, listContentHeight, listLayoutHeight, loadOlder, pinToBottom, props.committedMessagesCount, props.isLoaded, props.jumpToSeq, props.sessionId, props.sessionSeq]);

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
                        <ListFooter
                            sessionId={props.sessionId}
                            bottomNotice={props.bottomNotice}
                            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                        />
                    }
              />
              ) : (
                  <FlashList<ChatTranscriptListItem>
                      ref={(node) => {
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
                        estimatedItemSize={sync.getSyncTuning().transcriptFlashListEstimatedItemSize}
                      maintainVisibleContentPosition={
                          flashListMaintainVisibleContentPosition
                      }
                      onLayout={(e) => {
                          const h = e?.nativeEvent?.layout?.height;
                          if (typeof h === 'number' && Number.isFinite(h)) {
                              listLayoutHeightRef.current = h;
                              setListLayoutHeight(h);
                                if (listContentHeightRef.current > 0) {
                                    schedulePinToBottom();
                                }
                          }
                      }}
                      onContentSizeChange={(_, h) => {
                          if (typeof h === 'number' && Number.isFinite(h)) {
                              listContentHeightRef.current = h;
                              setListContentHeight(h);
                                if (listLayoutHeightRef.current > 0) {
                                    schedulePinToBottom();
                                }
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
                              const layoutH = listLayoutHeightRef.current;
                              const contentH = listContentHeightRef.current;
                              const distanceFromBottom =
                                  layoutH > 0 && contentH >= layoutH
                                      ? Math.max(0, Math.trunc(contentH - layoutH - y))
                                      : 0;
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
                          if (initialFillStatusRef.current !== 'done') return;
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
                            <ListFooter
                                sessionId={props.sessionId}
                                bottomNotice={props.bottomNotice}
                                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                            />
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
