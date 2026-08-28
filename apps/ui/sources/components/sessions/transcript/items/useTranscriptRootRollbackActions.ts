import * as React from 'react';
import { isBundledAgentId, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { useCurrentProjectedAgentCapabilities } from '@/agents/hooks/useCurrentProjectedAgentCapabilities';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    readSessionRollbackRangesV1,
    resolveTranscriptRollbackActions,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import { deriveTurnChangeSetsFromMessages } from '@/sync/domains/session/changes/derivation/deriveTurnChangeSetsFromMessages';
import type { ChatListProps } from '@/components/sessions/transcript/chatListTypes';
import { buildRollbackActionsInputSignature } from '@/components/sessions/transcript/items/rollbackActionsSignature';

type TurnChangeToolMessage = Extract<Message, { kind: 'tool-call' }>;

function listTurnChangeToolMessages(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): readonly TurnChangeToolMessage[] {
    const messages: TurnChangeToolMessage[] = [];
    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (message?.kind !== 'tool-call') continue;
        if (message.tool?.name !== 'Diff' && message.tool?.name !== 'Patch') continue;
        messages.push(message);
    }
    return messages;
}

function areSameMessages(
    previous: readonly TurnChangeToolMessage[],
    next: readonly TurnChangeToolMessage[],
): boolean {
    return previous.length === next.length && previous.every((message, index) => message === next[index]);
}

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
    const ownerMetadata = React.useMemo(
        () => readSessionOwnerMetadataView(session),
        [session],
    );
    const declaredAgentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
    const externalAgentId = declaredAgentId !== null && !isBundledAgentId(declaredAgentId)
        ? declaredAgentId
        : null;
    const sessionServerId = usePreferredServerIdForSession(session.id, session.serverId ?? null);
    const currentAgentCapabilities = useCurrentProjectedAgentCapabilities({
        agentId: externalAgentId,
        machineId: ownerMetadata?.machineId ?? null,
        serverId: sessionServerId,
        enabled: externalAgentId !== null,
    });
    const rollbackRanges = React.useMemo(
        () => readSessionRollbackRangesV1((stableSessionMetadata as Record<string, unknown> | null | undefined) ?? null),
        [sessionMetadataSignature, stableSessionMetadata],
    );
    // The transcript store mutates these containers in place and uses a separate revision to
    // trigger this root render. Recompute the content signature instead of memoizing by identity.
    const rollbackActionsInputSignature = buildRollbackActionsInputSignature({
        messageIdsOldestFirst,
        messagesById,
    });
    const turnChangeSetsCacheRef = React.useRef<Readonly<{
        sourceMessages: readonly TurnChangeToolMessage[];
        turnChangeSets: ReturnType<typeof deriveTurnChangeSetsFromMessages>;
    }>>({ sourceMessages: [], turnChangeSets: [] });
    const turnChangeToolMessages = listTurnChangeToolMessages({ messageIdsOldestFirst, messagesById });
    if (!areSameMessages(turnChangeSetsCacheRef.current.sourceMessages, turnChangeToolMessages)) {
        turnChangeSetsCacheRef.current = {
            sourceMessages: turnChangeToolMessages,
            turnChangeSets: deriveTurnChangeSetsFromMessages(turnChangeToolMessages),
        };
    }
    const turnChangeSets = turnChangeSetsCacheRef.current.turnChangeSets;
    const rollbackActionsByMessageId = React.useMemo(
        () => resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst,
            messagesById,
            rollbackRanges,
            turnChangeSets,
            currentAgentCapabilities,
        }),
        [
            session.accessLevel,
            session.active,
            session.rollbackEligibleTurnStarts,
            sessionMetadataSignature,
            rollbackActionsInputSignature,
            rollbackRanges,
            turnChangeSets,
            currentAgentCapabilities,
        ],
    );

    return {
        rollbackActionsByMessageId,
        rollbackRanges,
    };
}
