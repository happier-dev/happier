import { describe, expect, it } from 'vitest';

import { applySendToSessionTemplate } from './applySendToSessionTemplate';

describe('applySendToSessionTemplate', () => {
    it('substitutes messages', () => {
        expect(applySendToSessionTemplate({
            template: 'Review this:\n\n{{MESSAGES}}',
            formattedMessages: 'Hello',
            selectedCount: 1,
            sourceSessionName: 'Source',
        })).toBe('Review this:\n\nHello');
    });

    it('substitutes selected count and source session name', () => {
        expect(applySendToSessionTemplate({
            template: 'From {{SOURCE_SESSION_NAME}} ({{SELECTED_COUNT}}):\n{{MESSAGES}}',
            formattedMessages: 'A\n\nB',
            selectedCount: 2,
            sourceSessionName: 'Planning',
        })).toBe('From Planning (2):\nA\n\nB');
    });

    it('replaces multiple occurrences and leaves unknown placeholders literal', () => {
        expect(applySendToSessionTemplate({
            template: '{{MESSAGES}}\nAgain: {{MESSAGES}}\nUnknown: {{FOO}}',
            formattedMessages: 'Body',
            selectedCount: 1,
            sourceSessionName: null,
        })).toBe('Body\nAgain: Body\nUnknown: {{FOO}}');
    });

    it('uses an empty string for a missing source session name', () => {
        expect(applySendToSessionTemplate({
            template: 'From "{{SOURCE_SESSION_NAME}}"\n{{MESSAGES}}',
            formattedMessages: 'Body',
            selectedCount: 1,
            sourceSessionName: null,
        })).toBe('From ""\nBody');
    });

    it('appends messages when the template omits the messages placeholder', () => {
        expect(applySendToSessionTemplate({
            template: 'Please continue from here.   ',
            formattedMessages: 'Body',
            selectedCount: 1,
            sourceSessionName: null,
        })).toBe('Please continue from here.\n\nBody');
    });

    it('returns messages when the template is empty or whitespace', () => {
        expect(applySendToSessionTemplate({
            template: '   ',
            formattedMessages: 'Body',
            selectedCount: 1,
            sourceSessionName: null,
        })).toBe('Body');
    });

    it('handles templates at the configured boundary without crashing', () => {
        const template = `${'x'.repeat(1990)}{{MESSAGES}}`;
        const result = applySendToSessionTemplate({
            template,
            formattedMessages: 'Body',
            selectedCount: 1,
            sourceSessionName: null,
        });

        expect(result.endsWith('Body')).toBe(true);
    });
});
