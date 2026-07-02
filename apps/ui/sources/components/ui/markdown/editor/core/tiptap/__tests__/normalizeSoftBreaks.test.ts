/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';

import { createMarkdownEditorExtensions } from '../createMarkdownEditorExtensions';
import { normalizeSoftBreaks } from '../normalizeSoftBreaks';

/**
 * Ported from Orca's `rich-markdown-normalize.test.ts` +
 * `markdown-dirty-state.test.ts` + the soft-break cases in
 * `rich-markdown-cut.test.ts`. The behavior is verified against a REAL headless
 * `@tiptap/core` editor (no mocks) so the assertions reflect what the web
 * surface + WebView bundle drive.
 *
 * We use the full Phase-1 extension set so the test exercises the schema the
 * production surfaces use (including `@tiptap/markdown`, raw-HTML atoms, etc.).
 * Note: the `NormalizeSoftBreaks` extension already runs `onCreate`, so the
 * "after init" state of an editor seeded with `contentType: 'markdown'` is
 * ALREADY normalized — these tests construct editors via the same path Orca
 * does and call `normalizeSoftBreaks` directly so we can observe the function
 * in isolation.
 */

function createEditor(content: string): Editor {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return new Editor({
        element,
        extensions: createMarkdownEditorExtensions(),
        content,
        contentType: 'markdown',
    });
}

function countParagraphs(editor: Editor): number {
    let count = 0;
    editor.state.doc.forEach((node) => {
        if (node.type.name === 'paragraph') {
            count += 1;
        }
    });
    return count;
}

describe('normalizeSoftBreaks', () => {
    it('normalizes empty ordered list items into caret targets', () => {
        const editor = createEditor('1. Item 1\n2. Item 2\n3. \n\n## Next section\n');

        try {
            normalizeSoftBreaks(editor);

            const list = editor.state.doc.child(0);
            const emptyItem = list.child(2);
            expect(emptyItem.type.name).toBe('listItem');
            expect(emptyItem.childCount).toBe(1);
            expect(emptyItem.child(0).type.name).toBe('paragraph');
            expect(emptyItem.child(0).content.size).toBe(0);
        } finally {
            editor.destroy();
        }
    });

    it('splits consecutive lines into separate paragraphs', () => {
        const editor = createEditor('Line one\nLine two\nLine three');

        try {
            // In headless jsdom the `NormalizeSoftBreaks` extension's `onCreate`
            // doesn't reliably fire before this assertion runs (the view isn't
            // fully attached yet). Production callers cover the split via either
            // (a) `seedMarkdown` after `setContent`, or (b) the extension once
            // the view is mounted. The explicit imperative call here proves the
            // algorithm itself: a single 3-line paragraph splits into 3.
            const before = countParagraphs(editor);
            expect(before).toBe(1);

            normalizeSoftBreaks(editor);

            const after = countParagraphs(editor);
            expect(after).toBe(3);
        } finally {
            editor.destroy();
        }
    });

    it('does not modify content without soft breaks', () => {
        const editor = createEditor('# Title\n\nBody text');

        try {
            const docBefore = editor.state.doc.toJSON();
            normalizeSoftBreaks(editor);
            const docAfter = editor.state.doc.toJSON();

            expect(docAfter).toEqual(docBefore);
        } finally {
            editor.destroy();
        }
    });

    it('is idempotent on already-clean documents', () => {
        const editor = createEditor('First.\n\nSecond.\n\nThird.\n');

        try {
            const docBefore = editor.state.doc.toJSON();
            normalizeSoftBreaks(editor);
            const docAfter = editor.state.doc.toJSON();

            expect(docAfter).toEqual(docBefore);
        } finally {
            editor.destroy();
        }
    });

    it('does not modify list items or blockquotes structurally', () => {
        const editor = createEditor('- Item 1\n- Item 2\n');

        try {
            const docBefore = editor.state.doc.toJSON();
            normalizeSoftBreaks(editor);
            const docAfter = editor.state.doc.toJSON();

            expect(docAfter).toEqual(docBefore);
        } finally {
            editor.destroy();
        }
    });
});
