/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';

import { createMarkdownEditorExtensions } from '../createMarkdownEditorExtensions';
import {
    readActiveLinkHref,
    readSelectionState,
    runMarkdownEditorCommand,
} from '../markdownEditorCommands';

/**
 * F6 / Lane F: the command registry maps each Phase-1 `MarkdownEditorCommand`
 * onto a live TipTap `Editor` operation, and `readSelectionState` projects the
 * full `MarkdownSelectionState` (including `isLinkActive`/`linkHref`).
 *
 * We use a REAL headless `@tiptap/core` editor mounted on a jsdom element (no
 * mocks) so the command behavior is exactly what the web surface + WebView
 * bundle drive. Each command's effect is observed via the editor's own
 * `isActive(...)`/marks (real state), not via spies on the editor.
 */

const editors: Editor[] = [];

function createEditor(content = ''): Editor {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
        element,
        extensions: createMarkdownEditorExtensions(),
        content,
        contentType: 'markdown',
    });
    editors.push(editor);
    // Select the block's text via a TextSelection — NOT selectAll()/AllSelection,
    // which block-type commands (setHeading/toggleBulletList/…) don't apply to in
    // headless ProseMirror. Marks and block toggles both work on this range.
    const docEnd = Math.max(1, editor.state.doc.content.size - 1);
    editor.commands.setTextSelection({ from: 1, to: docEnd });
    return editor;
}

afterEach(() => {
    while (editors.length > 0) {
        const editor = editors.pop();
        try {
            editor?.destroy();
        } catch {
            // ignore teardown errors
        }
    }
    vi.restoreAllMocks();
});

describe('runMarkdownEditorCommand mark toggles', () => {
    it('toggleBold turns the bold mark on then off', () => {
        const editor = createEditor('plain');
        runMarkdownEditorCommand(editor, { kind: 'toggleBold' });
        expect(editor.isActive('bold')).toBe(true);
        runMarkdownEditorCommand(editor, { kind: 'toggleBold' });
        expect(editor.isActive('bold')).toBe(false);
    });

    it('toggleItalic turns the italic mark on', () => {
        const editor = createEditor('plain');
        runMarkdownEditorCommand(editor, { kind: 'toggleItalic' });
        expect(editor.isActive('italic')).toBe(true);
    });

    it('toggleStrike turns the strike mark on', () => {
        const editor = createEditor('plain');
        runMarkdownEditorCommand(editor, { kind: 'toggleStrike' });
        expect(editor.isActive('strike')).toBe(true);
    });

    it('toggleCode turns the inline code mark on', () => {
        const editor = createEditor('plain');
        runMarkdownEditorCommand(editor, { kind: 'toggleCode' });
        expect(editor.isActive('code')).toBe(true);
    });
});

describe('runMarkdownEditorCommand block toggles', () => {
    it('setHeading applies the requested heading level', () => {
        const editor = createEditor('plain');
        runMarkdownEditorCommand(editor, { kind: 'setHeading', level: 2 });
        expect(editor.isActive('heading', { level: 2 })).toBe(true);
    });

    it('setHeading toggles back to a paragraph when the same level is active', () => {
        const editor = createEditor('plain');
        runMarkdownEditorCommand(editor, { kind: 'setHeading', level: 2 });
        expect(editor.isActive('heading', { level: 2 })).toBe(true);
        runMarkdownEditorCommand(editor, { kind: 'setHeading', level: 2 });
        expect(editor.isActive('heading', { level: 2 })).toBe(false);
        expect(editor.isActive('paragraph')).toBe(true);
    });

    it('toggleBulletList wraps the selection in a bullet list', () => {
        const editor = createEditor('item');
        runMarkdownEditorCommand(editor, { kind: 'toggleBulletList' });
        expect(editor.isActive('bulletList')).toBe(true);
    });

    it('toggleOrderedList wraps the selection in an ordered list', () => {
        const editor = createEditor('item');
        runMarkdownEditorCommand(editor, { kind: 'toggleOrderedList' });
        expect(editor.isActive('orderedList')).toBe(true);
    });

    it('toggleTaskList wraps the selection in a task list', () => {
        const editor = createEditor('item');
        runMarkdownEditorCommand(editor, { kind: 'toggleTaskList' });
        expect(editor.isActive('taskList')).toBe(true);
    });

    it('toggleBlockquote wraps the selection in a blockquote', () => {
        const editor = createEditor('quote me');
        runMarkdownEditorCommand(editor, { kind: 'toggleBlockquote' });
        expect(editor.isActive('blockquote')).toBe(true);
    });

    it('toggleCodeBlock converts the block into a code block', () => {
        const editor = createEditor('code me');
        runMarkdownEditorCommand(editor, { kind: 'toggleCodeBlock' });
        expect(editor.isActive('codeBlock')).toBe(true);
    });

    it('setHorizontalRule inserts a horizontal rule node', () => {
        const editor = createEditor('above');
        runMarkdownEditorCommand(editor, { kind: 'setHorizontalRule' });
        const markdown = editor.getMarkdown();
        expect(markdown).toMatch(/(^|\n)(-{3,}|\*{3,}|_{3,})(\n|$)/);
    });

    it('does not mutate the document when the editor is read-only', () => {
        const editor = createEditor('plain');
        editor.setEditable(false);

        runMarkdownEditorCommand(editor, { kind: 'toggleBold' });

        expect(editor.isActive('bold')).toBe(false);
        expect(editor.getMarkdown()).toBe('plain');
    });
});

describe('link commands', () => {
    it('unlink removes an active link mark across its range', () => {
        const editor = createEditor('A [link](https://example.com) here.');
        editor.commands.selectAll();
        // Sanity: a link mark exists in the seeded content.
        expect(editor.getMarkdown()).toContain('https://example.com');

        // Place the caret inside the link, then unlink.
        runMarkdownEditorCommand(editor, { kind: 'unlink' });
        expect(editor.isActive('link')).toBe(false);
    });

    it('openLink resolves the active href and delegates to the injected opener', () => {
        const editor = createEditor('A [link](https://example.com/page) here.');
        // Select the link text so it is the active link.
        editor.commands.selectAll();

        const opener = vi.fn();
        runMarkdownEditorCommand(editor, { kind: 'openLink' }, { openLink: opener });

        expect(opener).toHaveBeenCalledWith('https://example.com/page');
    });

    it('openLink does not call the opener when no link is active', () => {
        const editor = createEditor('plain text, no link');
        editor.commands.selectAll();

        const opener = vi.fn();
        runMarkdownEditorCommand(editor, { kind: 'openLink' }, { openLink: opener });

        expect(opener).not.toHaveBeenCalled();
    });

    it('setLink updates the href of an existing link with collapsed caret inside it', () => {
        const editor = createEditor('[GitHub](https://github.com)');
        editor.commands.setTextSelection(3);

        runMarkdownEditorCommand(editor, { kind: 'setLink', href: 'https://new.example.com' });

        const markdown = editor.getMarkdown();
        expect(markdown).toContain('https://new.example.com');
        expect(markdown).not.toContain('https://github.com');
        expect(markdown).toContain('GitHub');
    });

    it('setLink applies a link mark to selected text', () => {
        const editor = createEditor('click here');
        editor.commands.selectAll();

        runMarkdownEditorCommand(editor, { kind: 'setLink', href: 'https://example.com' });

        expect(editor.isActive('link')).toBe(true);
        expect(editor.getMarkdown()).toContain('https://example.com');
    });

    it('setLink does not mutate the document when the editor is read-only', () => {
        const editor = createEditor('[link](https://old.com)');
        editor.commands.selectAll();
        editor.setEditable(false);

        runMarkdownEditorCommand(editor, { kind: 'setLink', href: 'https://new.com' });

        const markdown = editor.getMarkdown();
        expect(markdown).toContain('https://old.com');
        expect(markdown).not.toContain('https://new.com');
    });
});

describe('readActiveLinkHref', () => {
    it('returns the href when a link is selected', () => {
        const editor = createEditor('A [link](https://example.com/x) here.');
        editor.commands.selectAll();
        expect(readActiveLinkHref(editor)).toBe('https://example.com/x');
    });

    it('returns undefined when no link is selected', () => {
        const editor = createEditor('plain');
        editor.commands.selectAll();
        expect(readActiveLinkHref(editor)).toBeUndefined();
    });
});

describe('readSelectionState', () => {
    it('reports active marks', () => {
        const editor = createEditor('text');
        runMarkdownEditorCommand(editor, { kind: 'toggleBold' });
        runMarkdownEditorCommand(editor, { kind: 'toggleItalic' });

        const state = readSelectionState(editor);
        expect(state.marks.bold).toBe(true);
        expect(state.marks.italic).toBe(true);
        expect(state.marks.strike).toBe(false);
        expect(state.marks.code).toBe(false);
    });

    it('reports the active heading block type', () => {
        const editor = createEditor('title');
        runMarkdownEditorCommand(editor, { kind: 'setHeading', level: 3 });
        expect(readSelectionState(editor).blockType).toBe('heading3');
    });

    it('reports a paragraph block type for plain text', () => {
        const editor = createEditor('plain');
        expect(readSelectionState(editor).blockType).toBe('paragraph');
    });

    it('reports link state including the href when a link is active', () => {
        // All-linked content: selectAll covers only linked text, so isActive('link')
        // is true (surrounding non-linked text would make it false).
        const editor = createEditor('[link](https://example.com/y)');
        editor.commands.selectAll();
        const state = readSelectionState(editor);
        expect(state.isLinkActive).toBe(true);
        expect(state.linkHref).toBe('https://example.com/y');
    });

    it('reports no link state and no href when no link is active', () => {
        const editor = createEditor('plain');
        const state = readSelectionState(editor);
        expect(state.isLinkActive).toBe(false);
        expect(state.linkHref).toBeUndefined();
    });

    it('exposes undo/redo availability as booleans', () => {
        const editor = createEditor('text');
        const state = readSelectionState(editor);
        expect(typeof state.canUndo).toBe('boolean');
        expect(typeof state.canRedo).toBe('boolean');
    });

    it('reflects undo availability after an edit', () => {
        const editor = createEditor('text');
        runMarkdownEditorCommand(editor, { kind: 'toggleBold' });
        expect(readSelectionState(editor).canUndo).toBe(true);
    });
});
