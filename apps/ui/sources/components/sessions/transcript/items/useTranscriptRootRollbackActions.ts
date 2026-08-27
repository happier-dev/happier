import * as React from 'react';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    readSessionRollbackRangesV1,
    resolveTranscriptRollbackActions,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import type { ChatListProps } from '@/components/sessions/transcript/chatListTypes';
import { buildRollbackActionsInputSignature } from '@/components/sessions/transcript/items/rollbackActionsSignature';

export function useTranscriptRootRollbackActions(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    session: ChatListProps['session'];
    sessionMetadataSignature: string;
    stableSessionMetadata: unknown;
}>) {
    const {
        messageIdsOldestFirst,
        messagesById,
        session,
        sessionMetadataSignature,
        stableSessionMetadata,
    } = params;
    const rollbackRanges = React.useMemo(
        () => readSessionRollbackRangesV1((stableSessionMetadata as Record<string, unknown> | null | undefined) ?? null),
        [sessionMetadataSignature, stableSessionMetadata],
    );
    const rollbackActionsInputSignature = React.useMemo(
        () => buildRollbackActionsInputSignature({ messageIdsOldestFirst, messagesById }),
        [messageIdsOldestFirst, messagesById],
    );
    const rollbackActionsByMessageId = React.useMemo(
        () => resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst,
            messagesById,
            rollbackRanges,
        }),
        [
            session.accessLevel,
            session.active,
            session.sessionTurns,
            session.rollbackEligibleTurnStarts,
            sessionMetadataSignature,
            rollbackActionsInputSignature,
            rollbackRanges,
        ],
    );

    return {
        rollbackActionsByMessageId,
        rollbackRanges,
    };
}
