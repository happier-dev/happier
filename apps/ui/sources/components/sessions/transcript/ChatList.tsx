import * as React from 'react';

import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import { TranscriptMessageSelectionBoundary } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { PluginMessageActionHostProvider } from '@/components/sessions/transcript/messageActions/PluginMessageActions';
import { areChatListPropsEqual } from '@/components/sessions/transcript/chatListPropsEquality';
import { useChatListRootState } from '@/components/sessions/transcript/useChatListRootState';
import type { ChatListProps } from '@/components/sessions/transcript/chatListTypes';
import { ChatListInternal } from '@/components/sessions/transcript/ChatListInternal';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';

export type { TranscriptViewportChangeState } from '@/components/sessions/transcript/chatListTypes';

export const ChatList = React.memo(function ChatList(props: ChatListProps) {
    return (
        <PluginContextualResourceStoreProvider>
            <ChatListContent {...props} />
        </PluginContextualResourceStoreProvider>
    );
}, areChatListPropsEqual);

function ChatListContent(props: ChatListProps) {
    const rootState = useChatListRootState(props);
    return (
        <PluginMessageActionHostProvider host={rootState.pluginMessageActionHost}>
            <TranscriptMessageSelectionBoundary
                key={rootState.boundary.key}
                sessionId={rootState.boundary.sessionId}
                eligibleMessageIdsInOrder={rootState.boundary.eligibleMessageIdsInOrder}
                enabled={rootState.boundary.selectionEnabled}
            >
                <SyncPerformanceReactProfiler id="sessions.transcript.chatList">
                    <ChatListInternal {...rootState.internalProps} />
                </SyncPerformanceReactProfiler>
            </TranscriptMessageSelectionBoundary>
        </PluginMessageActionHostProvider>
    );
}
