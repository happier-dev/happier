import * as React from 'react';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { buildPendingSessionRequestsSourceSignature } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';
import { EMPTY_PENDING_USER_ACTION_REQUESTS } from '@/components/sessions/transcript/chatListEmptyValues';
import type { ChatListProps } from '@/components/sessions/transcript/chatListTypes';
import { useStableValueBySignature } from '@/components/sessions/transcript/items/stableValueBySignature';

export function useTranscriptRootPendingRequests(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    session: ChatListProps['session'];
}>) {
    const { messageIdsOldestFirst, messagesById, session } = params;
    const committedMessagesForPendingRequests = React.useMemo(() => (
        messageIdsOldestFirst
            .map((messageId) => messagesById[messageId])
            .filter((message): message is Message => Boolean(message))
    ), [messageIdsOldestFirst, messagesById]);
    const pendingRequestsSessionSignature = React.useMemo(
        () => buildPendingSessionRequestsSourceSignature(session),
        [
            session.active,
            session.agentState,
            session.id,
            session.pendingPermissionRequestCount,
            session.pendingRequestObservedAt,
            session.pendingUserActionRequestCount,
        ],
    );
    const pendingRequestsSession = useStableValueBySignature(session, pendingRequestsSessionSignature);

    return React.useMemo(
        () => {
            const requests = listPendingUserActionRequests(pendingRequestsSession, committedMessagesForPendingRequests);
            return requests.length === 0 ? EMPTY_PENDING_USER_ACTION_REQUESTS : requests;
        },
        [committedMessagesForPendingRequests, pendingRequestsSession],
    );
}
