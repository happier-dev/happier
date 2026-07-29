import type { Message } from '@/sync/domains/messages/messageTypes';

export type TranscriptEventEmphasis = 'normal' | 'deemphasized';
export type TranscriptEventEmphasisByMessageId = Readonly<Record<string, TranscriptEventEmphasis>>;

const EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID: TranscriptEventEmphasisByMessageId = Object.freeze({});

export function resolveTranscriptEventEmphasisByMessageId(input: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    sessionActive: boolean;
}>): TranscriptEventEmphasisByMessageId {
    if (!input.sessionActive) return EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID;

    let latestReadyIndex = -1;
    input.messageIdsOldestFirst.forEach((messageId, index) => {
        const message = input.messagesById[messageId];
        if (message?.kind === 'agent-event' && message.event.type === 'ready') {
            latestReadyIndex = index;
        }
    });
    if (latestReadyIndex < 0) return EMPTY_TRANSCRIPT_EVENT_EMPHASIS_BY_MESSAGE_ID;

    const emphasisByMessageId: Record<string, TranscriptEventEmphasis> = {};
    for (let index = 0; index < latestReadyIndex; index += 1) {
        const messageId = input.messageIdsOldestFirst[index]!;
        const message = input.messagesById[messageId];
        if (message?.kind === 'agent-event' && message.event.type !== 'ready') {
            emphasisByMessageId[messageId] = 'deemphasized';
        }
    }
    return emphasisByMessageId;
}
