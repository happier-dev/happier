import * as React from 'react';
import { ActivityIndicator, FlatList, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@/utils/responsive';
import { MessageView } from '@/components/MessageView';
import { ChatFooter } from '@/components/ChatFooter';
import type { Message } from '@/sync/typesMessage';
import type { Metadata } from '@/sync/storageTypes';

type TranscriptInteraction = {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted';
    disableToolNavigation?: boolean;
};

export type TranscriptBottomNotice = {
    title: string;
    body: string;
};

const ListHeader = React.memo((props: { isLoading?: boolean }) => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return (
        <View>
            {props.isLoading ? (
                <View style={{ paddingVertical: 12 }}>
                    <ActivityIndicator size="small" />
                </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const ListFooter = React.memo((props: { bottomNotice?: TranscriptBottomNotice | null }) => {
    return <ChatFooter notice={props.bottomNotice ?? null} controlledByUser={false} />;
});

export const TranscriptList = React.memo((props: {
    sessionId: string;
    metadata: Metadata | null;
    messages: Message[];
    interaction: TranscriptInteraction;
    bottomNotice?: TranscriptBottomNotice | null;
    isLoaded?: boolean;
}) => {
    const keyExtractor = React.useCallback((item: Message) => item.id, []);
    const renderItem = React.useCallback(({ item }: { item: Message }) => {
        return (
            <MessageView
                message={item}
                metadata={props.metadata}
                sessionId={props.sessionId}
                interaction={props.interaction}
            />
        );
    }, [props.interaction, props.metadata, props.sessionId]);

    return (
        <FlatList
            data={props.messages}
            inverted={true}
            keyExtractor={keyExtractor}
            maintainVisibleContentPosition={{
                minIndexForVisible: 0,
                autoscrollToTopThreshold: 10,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            renderItem={renderItem}
            ListHeaderComponent={<ListHeader isLoading={props.isLoaded === false} />}
            ListFooterComponent={<ListFooter bottomNotice={props.bottomNotice ?? null} />}
        />
    );
});
