import { describe, expect, it } from 'vitest';

import { readSessionDisplayTitleField } from './selectors';
import type { Message } from '@happier-dev/session-core/messages';

describe('session state selectors', () => {
    it('reads display.title from canonical summary metadata', () => {
        expect(readSessionDisplayTitleField({
            metadata: {
                summary: {
                    text: '  Display title  ',
                    updatedAt: 123,
                },
            },
        })).toEqual({
            value: 'Display title',
            updatedAt: 123,
        });
    });

    it('reads display.title from renderable summaryText metadata when canonical summary is absent', () => {
        expect(readSessionDisplayTitleField({
            metadata: {
                summaryText: '  Cached renderable title  ',
            },
        })).toEqual({
            value: 'Cached renderable title',
            updatedAt: null,
        });
    });

    it('uses the first user message as a transient title for both full and row metadata', () => {
        const messages: Message[] = [{
            id: 'first-prompt', kind: 'user-text', localId: null, createdAt: 1,
            text: 'Internal prompt', displayText: '  Plan the\n release  ',
        }];
        for (const metadata of [{ path: '/tmp' }, { path: '/tmp', summaryText: null }]) {
            expect(readSessionDisplayTitleField({ metadata }, { messages })).toEqual({
                value: 'Plan the release', updatedAt: null,
            });
        }
        expect(readSessionDisplayTitleField({ metadata: { name: 'Release bot' } }, { messages }).value).toBeNull();
        expect(readSessionDisplayTitleField({ metadata: { summary: { text: 'Saved title', updatedAt: 2 } } }, { messages }))
            .toEqual({ value: 'Saved title', updatedAt: 2 });
        expect(readSessionDisplayTitleField({ metadata: null }, { messages }).value).toBeNull();
    });

    it.each([
        {
            text: '# **Plan release**\n\n<options>\n<option>Review changes</option>\n<option>Run checks</option>\n</options>',
            title: 'Plan release Review changes Run checks',
        },
        {
            text: '```xml\n<options><option>literal</option></options>\n```',
            title: '<options><option>literal</option></options>',
        },
    ])('projects a transient title from rendered transcript text: $title', ({ text, title }) => {
        const messages: Message[] = [{
            id: 'first-prompt', kind: 'user-text', localId: null, createdAt: 1, text,
        }];
        expect(readSessionDisplayTitleField({ metadata: { path: '/tmp' } }, { messages }).value).toBe(title);
    });});
