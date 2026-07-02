import { describe, expect, it } from 'vitest';

import * as entry from '../tiptapWebViewEntry';
import type { MarkdownEditorCommand } from '../../markdownEditorTypes';

type EntryWithParser = typeof entry & {
    parseMarkdownEditorCommandEnvelopePayload?: (payload: Record<string, unknown>) => MarkdownEditorCommand | null;
};

const parser = (entry as EntryWithParser).parseMarkdownEditorCommandEnvelopePayload;

describe('parseMarkdownEditorCommandEnvelopePayload', () => {
    it('reconstructs typed markdown commands from command-envelope payloads', () => {
        expect(typeof parser).toBe('function');

        expect(parser?.({ name: 'setHeading', args: { level: 2 } })).toEqual({
            kind: 'setHeading',
            level: 2,
        });
        expect(parser?.({ name: 'setLink', args: { href: 'https://example.com' } })).toEqual({
            kind: 'setLink',
            href: 'https://example.com',
        });
    });

    it('rejects invalid command payloads instead of casting them', () => {
        expect(typeof parser).toBe('function');

        expect(parser?.({ name: 'heading1', args: {} })).toBeNull();
        expect(parser?.({ name: 'setHeading', args: { level: 99 } })).toBeNull();
        expect(parser?.({ name: 'setLink', args: { href: 123 } })).toBeNull();
        expect(parser?.({ name: 'toggleBold', args: { extra: 'ignored' } })).toEqual({ kind: 'toggleBold' });
    });
});
