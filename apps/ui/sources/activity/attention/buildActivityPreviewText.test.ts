import { describe, expect, it } from 'vitest';

import type { Message } from "@happier-dev/session-core/messages";

import { buildActivityPreviewText } from './buildActivityPreviewText';
import { readRecentActivityMessages } from './readRecentActivityMessages';

describe('buildActivityPreviewText', () => {
    it('excludes thinking in both event previews and reverse transcript reads', () => {
        const reply: Message = { kind: 'agent-text', id: 'reply', localId: null, createdAt: 1, text: '  A\nreply ' };
        const thinking: Message = { kind: 'agent-text', id: 'thinking', localId: null, createdAt: 2, text: 'Private reasoning', isThinking: true };
        expect(buildActivityPreviewText({ messages: [thinking] })).toBeNull();
        expect(readRecentActivityMessages({ messageIdsOldestFirst: ['thinking'], messagesById: { thinking } }, false)).toEqual([]);
        expect(buildActivityPreviewText({ messages: [thinking, reply] })).toBe('A reply');
        expect(readRecentActivityMessages({ messageIdsOldestFirst: ['reply', 'thinking'], messagesById: { reply, thinking } }, false)).toEqual([{ id: 'reply', role: 'agent', text: 'A reply' }]);
    });
    it('keeps the newest conversational excerpts in order', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'older', localId: null, createdAt: 1, text: 'Older reply' },
            { kind: 'user-text', id: 'prompt', localId: null, createdAt: 2, text: 'The prompt' },
            { kind: 'agent-text', id: 'reply', localId: null, createdAt: 3, text: 'The reply' },
            { kind: 'user-text', id: 'followup', localId: null, createdAt: 4, text: 'Follow up' },
            { kind: 'agent-text', id: 'thinking', localId: null, createdAt: 5, text: 'Private reasoning', isThinking: true },
        ];
        const transcript = {
            messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
        };
        expect(readRecentActivityMessages(transcript, false)).toEqual([
            { id: 'prompt', role: 'user', text: 'The prompt' },
            { id: 'reply', role: 'agent', text: 'The reply' },
            { id: 'followup', role: 'user', text: 'Follow up' },
        ]);
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

    it('previews Markdown replies as plain text', () => {
        const reply: Message = { kind: 'agent-text', id: 'md', localId: null, createdAt: 1, text: '1. **Give it bright light.**\n2. Water it `weekly`.' };
        const preview = buildActivityPreviewText({ messages: [reply] });
        expect(preview).toContain('Give it bright light.');
        expect(preview).not.toMatch(/[*`]/);
        expect(readRecentActivityMessages({ messageIdsOldestFirst: ['md'], messagesById: { md: reply } }, false)).toEqual([{ id: 'md', role: 'agent', text: preview }]);
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
