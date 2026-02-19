import * as React from 'react';
import { useSession, useSessionActionDrafts, useSessionMessages, useSessionPendingMessages } from "@/sync/domains/state/storage";
import { ActivityIndicator, FlatList, Platform, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { ChatFooter } from './ChatFooter';
import { buildChatListItems, type ChatListItem } from '@/components/sessions/chatListItems';
import { PendingUserTextMessageView } from '@/components/sessions/pending/PendingUserTextMessageView';
import { SessionActionDraftCard } from '@/components/sessions/actions/SessionActionDraftCard';
import { sync } from '@/sync/sync';
import { getPermissionsInUiWhileLocal } from '@/sync/domains/state/agentStateCapabilities';
import { jumpToTranscriptSeq } from '@/utils/sessions/jumpToTranscriptSeq';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ScrollableChatListRef = Readonly<{
    scrollToIndex: (params: { index: number; animated?: boolean; viewPosition?: number }) => void;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
}>;

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

export const ChatList = React.memo((props: {
    session: Session;
    bottomNotice?: ChatListBottomNotice | null;
    onRequestSwitchToRemote?: () => void;
    jumpToSeq?: number | null;
}) => {
    const { messages, isLoaded } = useSessionMessages(props.session.id);
    const { messages: pendingMessages } = useSessionPendingMessages(props.session.id);
    const actionDrafts = useSessionActionDrafts(props.session.id);
    const items = React.useMemo(
        () => buildChatListItems({ messages, pendingMessages, actionDrafts }),
        [actionDrafts, messages, pendingMessages],
    );

    const interaction = React.useMemo(() => {
        const isOwner = !props.session.accessLevel;
        const canSendMessages =
            isOwner || props.session.accessLevel === 'edit' || props.session.accessLevel === 'admin';
        const canApprovePermissions =
            isOwner || props.session.canApprovePermissions === true;
        const permissionDisabledReason = isOwner
            ? undefined
            : (props.session.accessLevel === 'view' ? 'readOnly' : 'notGranted');
        return { canSendMessages, canApprovePermissions, permissionDisabledReason } as const;
    }, [props.session.accessLevel, props.session.canApprovePermissions]);

    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            sessionSeq={props.session.seq ?? 0}
            items={items}
            committedMessagesCount={messages.length}
            isLoaded={isLoaded}
            bottomNotice={props.bottomNotice}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            interaction={interaction}
            jumpToSeq={props.jumpToSeq ?? null}
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

const ChatListInternal = React.memo((props: {
    metadata: Metadata | null,
    sessionId: string,
    sessionSeq: number,
    items: ChatListItem[],
    committedMessagesCount: number,
    isLoaded: boolean,
    bottomNotice?: ChatListBottomNotice | null,
    onRequestSwitchToRemote?: () => void,
    interaction: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'readOnly' | 'notGranted';
    };
    jumpToSeq?: number | null;
}) => {
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);
    const [listContentHeight, setListContentHeight] = React.useState(0);
    const loadOlderInFlight = React.useRef(false);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const itemsRef = React.useRef<ChatListItem[]>(props.items);
    const lastJumpSeqRef = React.useRef<number | null>(null);
    const listLayoutHeightRef = React.useRef<number>(0);
    const listContentHeightRef = React.useRef<number>(0);
    const initialFillStatusRef = React.useRef<'idle' | 'in_progress' | 'done'>('idle');
    const initialPinSessionIdRef = React.useRef<string | null>(null);
    const chatListNativeId = React.useMemo(() => `ChatList.${props.sessionId}`, [props.sessionId]);

    React.useEffect(() => {
        itemsRef.current = props.items;
    }, [props.items]);

    const keyExtractor = useCallback((item: ChatListItem) => item.id, []);
    const renderItem = useCallback(({ item }: { item: ChatListItem }) => {
        if (item.kind === 'action-draft') {
            return <SessionActionDraftCard sessionId={props.sessionId} draft={item.draft} />;
        }
        if (item.kind === 'pending-user-text') {
            return (
                <PendingUserTextMessageView
                    sessionId={props.sessionId}
                    message={item.pending}
                    otherPendingCount={item.otherPendingCount}
                />
            );
        }
        return (
            <MessageView
                message={item.message}
                metadata={props.metadata}
                sessionId={props.sessionId}
                interaction={props.interaction}
            />
        );
    }, [props.interaction, props.metadata, props.sessionId]);

    const loadOlder = useCallback(async (): Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    } | null> => {
        if (!props.isLoaded) return null;
        // If the server has never emitted any committed transcript seq, pagination is a no-op.
        // IMPORTANT: committedMessagesCount can be 0 even when sessionSeq > 0 (e.g. sidechain-only newest page).
        if ((props.sessionSeq ?? 0) <= 0) return null;
        if (loadOlderInFlight.current || hasMoreOlder === false) {
            return null;
        }
        loadOlderInFlight.current = true;
        setIsLoadingOlder(true);
        try {
            const result = await sync.loadOlderMessages(props.sessionId);
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
    }, [props.isLoaded, props.committedMessagesCount, props.sessionId, hasMoreOlder]);

    const tryPinToBottomDom = React.useCallback((): boolean => {
        if (Platform.OS !== 'web') return false;
        if (typeof document === 'undefined') return false;
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;

        const root = (document as any)?.getElementById?.(chatListNativeId) as HTMLElement | null | undefined;
        if (!root) return false;

        const candidates: HTMLElement[] = [root];
        try {
            const desc = root.querySelectorAll?.('*') as NodeListOf<HTMLElement> | undefined;
            if (desc) candidates.push(...Array.from(desc));
        } catch {
            // ignore
        }

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

        try {
            if (typeof (best as any).scrollTo === 'function') {
                (best as any).scrollTo({ top: 0 });
            } else {
                (best as any).scrollTop = 0;
            }
        } catch {
            try {
                (best as any).scrollTop = 0;
            } catch {
                return false;
            }
        }

        return true;
    }, [chatListNativeId]);

    const pinToBottom = React.useCallback(() => {
        // In an inverted FlatList, offset=0 corresponds to the visual bottom (newest messages).
        const node: any = listRef.current as any;
        if (node && typeof node.scrollToOffset === 'function') {
            node.scrollToOffset({ offset: 0, animated: false });
        }
        // React Native Web can sometimes fail to wire up FlatList scroll APIs in time;
        // fall back to setting DOM scrollTop directly.
        tryPinToBottomDom();
    }, [tryPinToBottomDom]);

    React.useEffect(() => {
        if (!props.isLoaded) return;
        if (props.jumpToSeq != null) return;
        if (!props.sessionId) return;
        if (initialPinSessionIdRef.current === props.sessionId) return;

        // Some platforms (especially web + inverted lists) can apply scroll anchoring / restoration
        // during the first render+layout ticks, resulting in the transcript appearing "scrolled up"
        // after a refresh. Pin immediately and then re-pin after a couple microtasks / a frame to
        // ensure the visual bottom stays stable.
        initialPinSessionIdRef.current = props.sessionId;
        let cancelled = false;

        const attempt = () => {
            if (cancelled) return;
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
            for (const ms of [0, 16, 50, 100, 200, 400, 800]) {
                timeouts.push(setTimeout(attempt, ms));
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
        for (let i = 0; i < items.length; i++) {
            const it = items[i]!;
            if (it.kind !== 'message') continue;
            const seq = it.message.seq;
            if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
            const normalizedSeq = Math.trunc(seq);
            if (normalizedSeq === target) {
                exact = i;
                break;
            }
            if (normalizedSeq > target) {
                if (!nextAfter || normalizedSeq < nextAfter.seq) nextAfter = { idx: i, seq: normalizedSeq };
            } else if (normalizedSeq < target) {
                if (!prevBefore || normalizedSeq > prevBefore.seq) prevBefore = { idx: i, seq: normalizedSeq };
            }
        }
        if (exact != null) return exact;
        if (nextAfter) return nextAfter.idx;
        if (prevBefore) return prevBefore.idx;
        return null;
    }, [props.jumpToSeq]);

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
                    const result = await sync.loadOlderMessages(props.sessionId);
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
        if ((props.sessionSeq ?? 0) <= 0) return;
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
        <FlatList
            ref={(node) => {
                // react-test-renderer does not provide a stable ref object; we store it manually.
                listRef.current = node as unknown as ScrollableChatListRef | null;
            }}
            data={props.items}
            inverted={true}
            nativeID={chatListNativeId}
            keyExtractor={keyExtractor}
            maintainVisibleContentPosition={{
                minIndexForVisible: 0,
                autoscrollToTopThreshold: 10,
            }}
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
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            renderItem={renderItem}
            onEndReachedThreshold={0.2}
            onEndReached={() => {
                if (initialFillStatusRef.current !== 'done') return;
                void loadOlder();
            }}
            onScrollToIndexFailed={(info) => {
                // Best-effort fallback for dynamic-height rows.
                const offset = Math.max(0, Math.trunc(info.averageItemLength * info.index));
                listRef.current?.scrollToOffset({ offset, animated: true });
            }}
            ListHeaderComponent={
                <ListFooter
                    sessionId={props.sessionId}
                    bottomNotice={props.bottomNotice}
                    onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                />
            }
            ListFooterComponent={<ListHeader isLoadingOlder={isLoadingOlder} />}
        />
    )
});
