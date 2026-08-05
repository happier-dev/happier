import type { Message } from '@/sync/domains/messages/messageTypes';

import { resolveTranscriptUtteranceIdentity } from './transcriptFreshnessGate';

type PaintedIdentityItem =
    | Readonly<{ kind: 'pending-queue'; pendingMessages: readonly Readonly<{ localId?: string | null }>[] }>
    | Readonly<{ kind: 'message'; messageId: string }>
    | Readonly<{ kind: string }>;

function readUserUtteranceLocalId(message: Message | null | undefined): string | null {
    if (message?.kind !== 'user-text') return null;
    return typeof message.localId === 'string' && message.localId.length > 0 ? message.localId : null;
}

/** User utterance identities this rendered row paints, independent of its projection row id. */
export function resolveTranscriptRowPaintedIdentities(
    item: PaintedIdentityItem,
    getMessageById: (messageId: string) => Message | null,
): readonly string[] | null {
    if (item.kind === 'pending-queue') {
        const pendingMessages = (item as Extract<PaintedIdentityItem, { kind: 'pending-queue' }>).pendingMessages;
        const identities = pendingMessages
            .map((message) => resolveTranscriptUtteranceIdentity(message.localId))
            .filter((identity): identity is string => identity !== null);
        return identities.length > 0 ? identities : null;
    }

    if (item.kind === 'message') {
        const messageId = (item as Extract<PaintedIdentityItem, { kind: 'message' }>).messageId;
        const identity = resolveTranscriptUtteranceIdentity(readUserUtteranceLocalId(getMessageById(messageId)));
        return identity ? [identity] : null;
    }

    return null;
}
