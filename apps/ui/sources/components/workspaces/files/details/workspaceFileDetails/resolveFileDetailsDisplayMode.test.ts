import { describe, expect, it } from 'vitest';

import { resolveFileDetailsDisplayMode } from './resolveFileDetailsDisplayMode';

describe('resolveFileDetailsDisplayMode', () => {
    it('uses markdown preview for markdown files when no higher-priority mode is active', () => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: false,
            deepLinkSource: null,
            hasRenderableDiff: false,
            hasFileContent: true,
            markdownPreviewAvailable: true,
        })).toBe('markdown');
    });

    it('keeps diff ahead of markdown when a renderable diff is available', () => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: false,
            deepLinkSource: null,
            hasRenderableDiff: true,
            hasFileContent: true,
            markdownPreviewAvailable: true,
        })).toBe('diff');
    });

    it('keeps explicit file deep links in source mode', () => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: false,
            deepLinkSource: 'file',
            hasRenderableDiff: true,
            hasFileContent: true,
            markdownPreviewAvailable: true,
        })).toBe('file');
    });

    it('keeps editing drafts in source mode', () => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: true,
            deepLinkSource: null,
            hasRenderableDiff: true,
            hasFileContent: true,
            markdownPreviewAvailable: true,
        })).toBe('file');
    });
});
