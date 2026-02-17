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
    const loadOlderInFlight = React.useRef(false);
    const listRef = React.useRef<ScrollableChatListRef | null>(null);
    const itemsRef = React.useRef<ChatListItem[]>(props.items);
    const lastJumpSeqRef = React.useRef<number | null>(null);

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

    const loadOlder = useCallback(async () => {
        if (!props.isLoaded || props.committedMessagesCount === 0) {
            return;
        }
        if (loadOlderInFlight.current || hasMoreOlder === false) {
            return;
        }
        loadOlderInFlight.current = true;
        setIsLoadingOlder(true);
        try {
            const result = await sync.loadOlderMessages(props.sessionId);
            if (result.status === 'no_more') {
                setHasMoreOlder(false);
            } else if (result.status === 'loaded') {
                setHasMoreOlder(result.hasMore);
            }
        } finally {
            setIsLoadingOlder(false);
            loadOlderInFlight.current = false;
        }
    }, [props.isLoaded, props.committedMessagesCount, props.sessionId, hasMoreOlder]);

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
        void (async () => {
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
        })();
    }, [props.isLoaded, props.jumpToSeq, props.sessionId, resolveJumpIndex]);

    return (
        <FlatList
            ref={(node) => {
                // react-test-renderer does not provide a stable ref object; we store it manually.
                listRef.current = node as unknown as ScrollableChatListRef | null;
            }}
            data={props.items}
            inverted={true}
            keyExtractor={keyExtractor}
            maintainVisibleContentPosition={{
                minIndexForVisible: 0,
                autoscrollToTopThreshold: 10,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            renderItem={renderItem}
            onEndReachedThreshold={0.2}
            onEndReached={() => {
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
