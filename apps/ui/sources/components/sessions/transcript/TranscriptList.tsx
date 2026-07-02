import * as React from 'react';
import { FlatList, Platform, View } from 'react-native';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { ChatFooter } from '@/components/sessions/transcript/ChatFooter';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_TOP_GUTTER_PX,
    TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS,
} from '@/components/sessions/transcript/_constants';
import { useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';
import { useOptionalTranscriptSelectionState } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';

type TranscriptInteraction = {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    disableToolNavigation?: boolean;
};

export type TranscriptBottomNotice = {
    title: string;
    body: string;
};

const ListHeader = React.memo((props: { isLoading?: boolean }) => {
    return (
        <View>
            {props.isLoading ? (
                <View style={{ paddingVertical: 12 }}>
                    <ActivitySpinner size="small" />
                </View>
            ) : null}
            <View style={{ height: TRANSCRIPT_TOP_GUTTER_PX }} />
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
    const transcriptListImplementation = useSetting('transcriptListImplementation');
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const sessionThinkingDisplayMode = transcriptSessionCommon.messageDisplay.sessionThinkingDisplayMode;
    const sessionThinkingInlinePresentation = transcriptSessionCommon.messageDisplay.sessionThinkingInlinePresentation;
    const listImplementation = transcriptListImplementation === 'flatlist_legacy' ? 'flatlist_legacy' : 'flash_v2';
    const listData = React.useMemo(() => {
        if (listImplementation === 'flatlist_legacy') {
            // Legacy: inverted lists expect newest-first input.
            return [...props.messages].reverse();
        }
        return props.messages;
    }, [listImplementation, props.messages]);

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

    React.useEffect(() => {
        setThinkingExpandedByMessageId(new Map());
    }, [props.sessionId]);

    const keyExtractor = React.useCallback((item: Message) => item.id, []);
    const getItemType = React.useCallback((item: Message): string => item.kind, []);
    const renderItem = React.useCallback(({ item }: { item: Message }) => {
        const controlledThinking =
            item.kind === 'agent-text' &&
            item.isThinking === true &&
            sessionThinkingDisplayMode === 'inline';
        return (
            <MessageViewWithSessionCommon
                message={item}
                metadata={props.metadata}
                sessionId={props.sessionId}
                interaction={props.interaction}
                forkCommon={transcriptSessionCommon.fork}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                toolRouteCommon={transcriptSessionCommon.toolRoute}
                thinkingExpanded={controlledThinking ? resolveThinkingExpanded(item.id) : undefined}
                onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(item.id, next) : undefined}
            />
        );
    }, [
        props.interaction,
        props.metadata,
        props.sessionId,
        resolveThinkingExpanded,
        sessionThinkingDisplayMode,
        setThinkingExpanded,
        transcriptSessionCommon.fork,
        transcriptSessionCommon.messageDisplay,
        transcriptSessionCommon.toolChrome,
        transcriptSessionCommon.toolRoute,
    ]);

    return (
        listImplementation === 'flatlist_legacy' ? (
            <FlatList
                data={listData}
                extraData={transcriptMessageSelection.selectionVersion}
                inverted={true}
                keyExtractor={keyExtractor}
                maintainVisibleContentPosition={{
                    minIndexForVisible: 0,
                    autoscrollToTopThreshold: 10,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="none"
                scrollEventThrottle={TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS}
                renderItem={renderItem}
                ListHeaderComponent={<ListHeader isLoading={props.isLoaded === false} />}
                ListFooterComponent={<ListFooter bottomNotice={props.bottomNotice ?? null} />}
            />
        ) : (
            <FlashList
                data={listData}
                extraData={transcriptMessageSelection.selectionVersion}
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                maintainVisibleContentPosition={{ startRenderingFromBottom: true }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="none"
                scrollEventThrottle={
                    Platform.OS === 'web'
                        ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS
                }
                renderItem={renderItem}
                ListHeaderComponent={<ListHeader isLoading={props.isLoaded === false} />}
                ListFooterComponent={<ListFooter bottomNotice={props.bottomNotice ?? null} />}
            />
        )
    );
});
