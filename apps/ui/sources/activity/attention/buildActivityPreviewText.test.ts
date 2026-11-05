import { describe, expect, it } from 'vitest';

import type { Message } from "@happier-dev/session-core/messages";

import { buildActivityPreviewText } from './buildActivityPreviewText';
import { readLatestActivityAgentReply } from './readLatestActivityAgentReply';

describe('buildActivityPreviewText', () => {
    it('excludes thinking in both event previews and reverse transcript reads', () => {
        const reply: Message = { kind: 'agent-text', id: 'reply', localId: null, createdAt: 1, text: '  A\nreply ' };
        const thinking: Message = { kind: 'agent-text', id: 'thinking', localId: null, createdAt: 2, text: 'Private reasoning', isThinking: true };
        expect(buildActivityPreviewText({ messages: [thinking] })).toBeNull();
        expect(readLatestActivityAgentReply({ messageIdsOldestFirst: ['thinking'], messagesById: { thinking } })).toBeNull();
        expect(buildActivityPreviewText({ messages: [thinking, reply] })).toBe('A reply');
        expect(readLatestActivityAgentReply({ messageIdsOldestFirst: ['reply', 'thinking'], messagesById: { reply, thinking } })).toBe('A reply');
    });
    it('returns the latest assistant text preview trimmed to a single normalized line', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'm1',
                localId: null,
                createdAt: 1,
                text: 'First answer',
            },
            {
                kind: 'agent-text',
                id: 'm2',
                localId: null,
                createdAt: 2,
                text: '  Latest\n\nanswer  ',
            },
        ];

        expect(buildActivityPreviewText({ messages })).toBe('Latest answer');
    });

    it('returns null when there is no assistant text message', () => {
        const messages: Message[] = [
            {
                kind: 'user-text',
                id: 'm1',
                localId: null,
                createdAt: 1,
                text: 'Hello',
            },
        ];

        expect(buildActivityPreviewText({ messages })).toBeNull();
    });
});
