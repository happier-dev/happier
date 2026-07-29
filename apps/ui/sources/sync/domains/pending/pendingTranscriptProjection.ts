import type { Message } from '@/sync/domains/messages/messageTypes';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

export function shouldPreservePendingProjectionAfterCommittedUserLocalId(
    message: Pick<PendingMessage, 'source'>,
): boolean {
    return message.source === 'server_pending';
}

export function collectServerOwnedPendingLocalIds(
    pendingMessages: readonly PendingMessage[] | null | undefined,
    discardedMessages: readonly DiscardedPendingMessage[] | null | undefined,
): Set<string> {
    const localIds = new Set<string>();
    const collect = (message: Pick<PendingMessage, 'localId' | 'source'>) => {
        if (!shouldPreservePendingProjectionAfterCommittedUserLocalId(message)) return;
        if (message.localId) localIds.add(message.localId);
    };
    if (Array.isArray(pendingMessages)) {
        for (const message of pendingMessages) collect(message);
    }
    if (Array.isArray(discardedMessages)) {
        for (const message of discardedMessages) collect(message);
    }
    return localIds;
}

export function shouldShowCommittedTranscriptMessage(
    message: Message,
    serverOwnedPendingLocalIds: ReadonlySet<string>,
): boolean {
    const localId = 'localId' in message ? message.localId : null;
    return !localId || !serverOwnedPendingLocalIds.has(localId);
}

export function shouldShowPendingTranscriptMessage(
    message: PendingMessage,
    localIdsInTranscript: ReadonlySet<string>,
): boolean {
    if (!message.localId || !localIdsInTranscript.has(message.localId)) return true;
    return shouldPreservePendingProjectionAfterCommittedUserLocalId(message);
}

export function filterCommittedTranscriptMessageIdsForPendingState(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    pendingMessages?: readonly PendingMessage[] | null;
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
}>): string[] {
    const serverOwnedPendingLocalIds = collectServerOwnedPendingLocalIds(
        params.pendingMessages,
        params.discardedMessages,
    );
    if (serverOwnedPendingLocalIds.size === 0) return [...params.messageIdsOldestFirst];
    return params.messageIdsOldestFirst.filter((messageId) => {
        const message = params.messagesById[messageId];
        return !message || shouldShowCommittedTranscriptMessage(message, serverOwnedPendingLocalIds);
    });
}
