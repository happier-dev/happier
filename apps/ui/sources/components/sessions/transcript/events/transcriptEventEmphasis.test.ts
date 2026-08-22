import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { resolveTranscriptEventEmphasisByMessageId } from './transcriptEventEmphasis';

function eventMessage(
    id: string,
    event: Extract<Message, { kind: 'agent-event' }>['event'],
): Message {
    return {
        kind: 'agent-event',
        localId: null,
        id,
        createdAt: 1,
        event,
    };
}

function resolve(messages: readonly Message[], sessionActive: boolean) {
    return resolveTranscriptEventEmphasisByMessageId({
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
        sessionActive,
    });
}

describe('resolveTranscriptEventEmphasisByMessageId', () => {
    it('de-emphasizes only prior-ready-era events while the session is active', () => {
        const emphasis = resolve([
            eventMessage('old-failure', { type: 'message', message: 'Old failure' }),
            eventMessage('ready', { type: 'ready' }),
            eventMessage('current-failure', { type: 'message', message: 'Current failure' }),
        ], true);

        expect(emphasis['old-failure']).toBe('deemphasized');
        expect(emphasis.ready).toBeUndefined();
        expect(emphasis['current-failure']).toBeUndefined();
    });

    it('keeps prior-ready-era events at normal emphasis while the session is inactive', () => {
        const emphasis = resolve([
            eventMessage('old-failure', { type: 'message', message: 'Old failure' }),
            eventMessage('ready', { type: 'ready' }),
        ], false);

        expect(emphasis['old-failure']).toBeUndefined();
    });
});
