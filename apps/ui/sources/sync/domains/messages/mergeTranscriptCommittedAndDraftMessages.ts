import type { Message } from './messageTypes';

type TranscriptDraftMessage = Extract<Message, { kind: 'agent-text' }>;

function normalizeLocalId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function mergeTranscriptCommittedAndDraftMessages(params: Readonly<{
    committedIds: readonly string[];
    committedMessagesById: Readonly<Record<string, Message>>;
    draftMessages: readonly TranscriptDraftMessage[];
}>): Readonly<{
    ids: string[];
    messagesById: Record<string, Message>;
}> {
    if (params.draftMessages.length === 0) {
        return {
            ids: [...params.committedIds],
            messagesById: { ...params.committedMessagesById },
        };
    }

    const ids = [...params.committedIds];
    const messagesById: Record<string, Message> = { ...params.committedMessagesById };
    const committedIdByLocalId = new Map<string, string>();

    for (const committedId of params.committedIds) {
        const committedMessage = params.committedMessagesById[committedId];
        if (committedMessage?.kind !== 'agent-text') continue;
        const localId = normalizeLocalId(committedMessage.localId);
        if (!localId) continue;
        committedIdByLocalId.set(localId, committedId);
    }

    for (const draftMessage of params.draftMessages) {
        const localId = normalizeLocalId(draftMessage.localId);
        const committedId = localId ? committedIdByLocalId.get(localId) ?? null : null;
        if (!committedId) {
            ids.push(draftMessage.id);
            messagesById[draftMessage.id] = draftMessage;
            continue;
        }

        const committedMessage = messagesById[committedId];
        if (committedMessage?.kind !== 'agent-text') continue;

        messagesById[committedId] = {
            ...committedMessage,
            text: draftMessage.text,
            isThinking: draftMessage.isThinking ?? committedMessage.isThinking,
        };
    }

    return {
        ids,
        messagesById,
    };
}
