import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { buildActivityPreviewText } from './buildActivityPreviewText';

describe('buildActivityPreviewText', () => {
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
