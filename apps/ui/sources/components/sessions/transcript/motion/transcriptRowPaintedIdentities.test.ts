import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { resolveTranscriptRowPaintedIdentities } from './transcriptRowPaintedIdentities';

const userMessage: Message = {
    kind: 'user-text',
    id: 'user-1',
    localId: 'local-user-1',
    createdAt: 1,
    text: 'hello',
};
const agentMessage: Message = {
    kind: 'agent-text',
    id: 'agent-1',
    localId: 'local-agent-1',
    createdAt: 2,
    text: 'hi',
};
const messages = new Map<string, Message>([
    [userMessage.id, userMessage],
    [agentMessage.id, agentMessage],
]);
const getMessageById = (messageId: string) => messages.get(messageId) ?? null;

describe('resolveTranscriptRowPaintedIdentities', () => {
    it('uses the same utterance identity for pending and committed user rows', () => {
        expect(resolveTranscriptRowPaintedIdentities({
            kind: 'pending-queue',
            pendingMessages: [{ localId: 'local-user-1' }],
        }, getMessageById)).toEqual(['utterance:local-user-1']);

        expect(resolveTranscriptRowPaintedIdentities({
            kind: 'message',
            messageId: userMessage.id,
        }, getMessageById)).toEqual(['utterance:local-user-1']);
    });

    it('does not treat agent-local ids as user utterances', () => {
        expect(resolveTranscriptRowPaintedIdentities({
            kind: 'message',
            messageId: agentMessage.id,
        }, getMessageById)).toBeNull();
    });
});
