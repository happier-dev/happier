import { describe, expect, it } from 'vitest';

import { formatSelectedMessagesForClipboard } from './formatSelectedMessagesForClipboard';

describe('formatSelectedMessagesForClipboard', () => {
    const roleLabels = { user: 'You', assistant: 'Assistant' };

    it('returns an empty string for no entries', () => {
        expect(formatSelectedMessagesForClipboard([], { format: 'markdown_labeled', roleLabels })).toBe('');
    });

    it('formats one user message with Markdown role labels', () => {
        expect(formatSelectedMessagesForClipboard([
            { role: 'user', text: 'Hello' },
        ], { format: 'markdown_labeled', roleLabels })).toBe('**You:**\n\nHello');
    });

    it('formats multiple messages with labels and blank lines in caller-provided order', () => {
        expect(formatSelectedMessagesForClipboard([
            { role: 'assistant', text: 'First reply' },
            { role: 'user', text: 'Second prompt' },
        ], { format: 'markdown_labeled', roleLabels })).toBe([
            '**Assistant:**',
            '',
            'First reply',
            '',
            '**You:**',
            '',
            'Second prompt',
        ].join('\n'));
    });

    it('formats plain text entries without labels', () => {
        expect(formatSelectedMessagesForClipboard([
            { role: 'user', text: 'Prompt' },
            { role: 'assistant', text: 'Reply' },
        ], { format: 'plain', roleLabels })).toBe('Prompt\n\nReply');
    });

    it('preserves fenced code blocks verbatim', () => {
        const text = ['Here is code:', '', '```ts', 'const answer = 42;', '```'].join('\n');

        expect(formatSelectedMessagesForClipboard([
            { role: 'assistant', text },
        ], { format: 'markdown_labeled', roleLabels })).toBe(`**Assistant:**\n\n${text}`);
    });

    it('uses caller-supplied role labels', () => {
        expect(formatSelectedMessagesForClipboard([
            { role: 'user', text: 'Bonjour' },
            { role: 'assistant', text: 'Salut' },
        ], {
            format: 'markdown_labeled',
            roleLabels: { user: 'Utilisateur', assistant: 'Assistant FR' },
        })).toBe('**Utilisateur:**\n\nBonjour\n\n**Assistant FR:**\n\nSalut');
    });
});
