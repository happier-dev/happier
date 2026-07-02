import { describe, expect, it } from 'vitest';

import { resolveMarkdownSlashCommand } from '../resolveMarkdownSlashCommand';

describe('resolveMarkdownSlashCommand', () => {
    it('maps heading1 to setHeading level 1', () => {
        expect(resolveMarkdownSlashCommand('heading1')).toEqual({
            kind: 'setHeading',
            level: 1,
        });
    });

    it('maps heading2 to setHeading level 2', () => {
        expect(resolveMarkdownSlashCommand('heading2')).toEqual({
            kind: 'setHeading',
            level: 2,
        });
    });

    it('maps heading3 to setHeading level 3', () => {
        expect(resolveMarkdownSlashCommand('heading3')).toEqual({
            kind: 'setHeading',
            level: 3,
        });
    });

    it('maps bulletList to toggleBulletList', () => {
        expect(resolveMarkdownSlashCommand('bulletList')).toEqual({
            kind: 'toggleBulletList',
        });
    });

    it('maps orderedList to toggleOrderedList', () => {
        expect(resolveMarkdownSlashCommand('orderedList')).toEqual({
            kind: 'toggleOrderedList',
        });
    });

    it('maps taskList to toggleTaskList', () => {
        expect(resolveMarkdownSlashCommand('taskList')).toEqual({
            kind: 'toggleTaskList',
        });
    });

    it('maps blockquote to toggleBlockquote', () => {
        expect(resolveMarkdownSlashCommand('blockquote')).toEqual({
            kind: 'toggleBlockquote',
        });
    });

    it('maps codeBlock to toggleCodeBlock', () => {
        expect(resolveMarkdownSlashCommand('codeBlock')).toEqual({
            kind: 'toggleCodeBlock',
        });
    });

    it('maps horizontalRule to setHorizontalRule', () => {
        expect(resolveMarkdownSlashCommand('horizontalRule')).toEqual({
            kind: 'setHorizontalRule',
        });
    });

    it('returns null for unknown command id', () => {
        expect(resolveMarkdownSlashCommand('unknownCommand')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(resolveMarkdownSlashCommand('')).toBeNull();
    });

    it('does not map link (deferred per D50)', () => {
        expect(resolveMarkdownSlashCommand('link')).toBeNull();
    });
});
