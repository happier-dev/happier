import * as React from 'react';
import { useSession, useSessionMessages, useSessionPendingMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, Platform, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { buildChatListItems, type ChatListItem } from '@/components/sessions/chatListItems';
import { PendingUserTextMessageView } from '@/components/sessions/pending/PendingUserTextMessageView';
import { sync } from '@/sync/sync';

export type ChatListBottomNotice = {
    title: string;
    body: string;
};

export const ChatList = React.memo((props: { session: Session; bottomNotice?: ChatListBottomNotice | null }) => {
    const { messages, isLoaded } = useSessionMessages(props.session.id);
    const { messages: pendingMessages } = useSessionPendingMessages(props.session.id);
    const items = React.useMemo(() => buildChatListItems({ messages, pendingMessages }), [messages, pendingMessages]);
    return (
        <ChatListInternal
            metadata={props.session.metadata}
            sessionId={props.session.id}
            items={items}
            committedMessagesCount={messages.length}
            isLoaded={isLoaded}
            bottomNotice={props.bottomNotice}
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

const ListFooter = React.memo((props: { sessionId: string; bottomNotice?: ChatListBottomNotice | null }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter
            controlledByUser={session.agentState?.controlledByUser || false}
            notice={props.bottomNotice ?? null}
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
}) => {
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [hasMoreOlder, setHasMoreOlder] = React.useState<boolean | null>(null);
    const loadOlderInFlight = React.useRef(false);

    const keyExtractor = useCallback((item: ChatListItem) => item.id, []);
    const renderItem = useCallback(({ item }: { item: ChatListItem }) => {
        if (item.kind === 'pending-user-text') {
            return (
                <PendingUserTextMessageView
                    sessionId={props.sessionId}
                    message={item.pending}
                    otherPendingCount={item.otherPendingCount}
                />
            );
        }
        return <MessageView message={item.message} metadata={props.metadata} sessionId={props.sessionId} />;
    }, [props.metadata, props.sessionId]);

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

    return (
        <FlatList
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
            ListHeaderComponent={<ListFooter sessionId={props.sessionId} bottomNotice={props.bottomNotice} />}
            ListFooterComponent={<ListHeader isLoadingOlder={isLoadingOlder} />}
        />
    )
});
