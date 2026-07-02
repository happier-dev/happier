/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';

import { createMarkdownEditorExtensions } from '../createMarkdownEditorExtensions';
import type { MenuTriggerKeyDownEvent, MenuTriggerState } from '../menuTriggerExtensionTypes';

/**
 * Lane F: the `MenuTriggerExtension` detects a slash trigger at the caret
 * position, computes a caret rect, and emits `MenuTriggerState | null` via the
 * `onMenuTriggerChange` callback. It mirrors Orca's `syncSlashMenu` as a
 * TipTap Extension.
 *
 * We use a REAL headless `@tiptap/core` Editor mounted on a jsdom element.
 * `view.coordsAtPos` is mocked because jsdom has no layout engine — it returns
 * canned coordinates so we can test the rect computation deterministically.
 */

const MOCK_COORDS = { left: 100, top: 200, bottom: 220, right: 110 };

const editors: Editor[] = [];

function createEditorWithMenuTrigger(
    content: string,
    onMenuTriggerChange: (state: MenuTriggerState | null) => void,
    onMenuTriggerKeyDown?: (event: MenuTriggerKeyDownEvent) => boolean,
): Editor {
    const element = document.createElement('div');
    document.body.appendChild(element);
    // Pass the callback through `createMarkdownEditorExtensions` so the
    // `MenuTriggerExtension` is registered exactly once (avoids the TipTap
    // "duplicate extension names" warning).
    const extensions = createMarkdownEditorExtensions({ onMenuTriggerChange, onMenuTriggerKeyDown });
    const editor = new Editor({
        element,
        extensions,
        content,
        contentType: 'markdown',
    });

    // Mock coordsAtPos since jsdom has no layout engine.
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue(MOCK_COORDS);

    editors.push(editor);
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

describe('MenuTriggerExtension', () => {
    it('emits a trigger state when "/" is typed at the start of a block', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        // Type "/" into the editor
        editor.commands.setContent('<p>/</p>');
        editor.commands.setTextSelection(2); // After the "/"

        // The callback should have been called with a non-null trigger state
        const lastCall = callback.mock.calls[callback.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        const state = lastCall[0] as MenuTriggerState;
        expect(state).not.toBeNull();
        expect(state.kind).toBe('slash');
        expect(state.query).toBe('');
    });

    it('emits the correct query when typing after "/"', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        // Type "/heading" into the editor
        editor.commands.setContent('<p>/heading</p>');
        editor.commands.setTextSelection(9); // After "/heading"

        const lastCall = callback.mock.calls[callback.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        const state = lastCall[0] as MenuTriggerState;
        expect(state).not.toBeNull();
        expect(state.kind).toBe('slash');
        expect(state.query).toBe('heading');
    });

    it('emits correct from/to ProseMirror positions', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        // Set content with "/" at start of block
        editor.commands.setContent('<p>/test</p>');
        editor.commands.setTextSelection(6); // After "/test"

        const lastCall = callback.mock.calls[callback.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        const state = lastCall[0] as MenuTriggerState;
        expect(state).not.toBeNull();
        expect(state.from).toBeLessThan(state.to);
    });

    it('emits caretRect from coordsAtPos in viewport coordinates', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        editor.commands.setContent('<p>/</p>');
        editor.commands.setTextSelection(2);

        const lastCall = callback.mock.calls[callback.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        const state = lastCall[0] as MenuTriggerState;
        expect(state).not.toBeNull();
        expect(state.caretRect).toEqual({
            left: MOCK_COORDS.left,
            top: MOCK_COORDS.top,
            height: MOCK_COORDS.bottom - MOCK_COORDS.top,
        });
    });

    it('emits null when the slash is deleted', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        // Type "/"
        editor.commands.setContent('<p>/</p>');
        editor.commands.setTextSelection(2);

        // Now clear the content (simulates deleting "/")
        callback.mockClear();
        editor.commands.setContent('<p></p>');
        editor.commands.setTextSelection(1);

        const lastCall = callback.mock.calls[callback.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        expect(lastCall[0]).toBeNull();
    });

    it('emits null when the selection is not empty (text is selected)', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        // Set content with "/"
        editor.commands.setContent('<p>/test</p>');
        // Select a range (non-empty selection)
        editor.commands.setTextSelection({ from: 1, to: 4 });

        const lastCall = callback.mock.calls[callback.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        expect(lastCall[0]).toBeNull();
    });

    it('emits null when "/" is not at the start of the block text', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        // "hello /" — slash not at the start of block text
        editor.commands.setContent('<p>hello /</p>');
        editor.commands.setTextSelection(9);

        const lastCall = callback.mock.calls[callback.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        // The regex requires `^\s*\/...` so "hello /" should NOT match
        expect(lastCall[0]).toBeNull();
    });

    it('emits trigger state when "/" follows only whitespace', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        // "  /test" — slash after whitespace at the start of block
        editor.commands.setContent('<p>  /test</p>');
        editor.commands.setTextSelection(8); // After "  /test"

        const lastCall = callback.mock.calls[callback.mock.calls.length - 1];
        expect(lastCall).toBeDefined();
        const state = lastCall[0] as MenuTriggerState;
        expect(state).not.toBeNull();
        expect(state.kind).toBe('slash');
        expect(state.query).toBe('test');
    });

    it('does not trigger when the editor is not editable', () => {
        const callback = vi.fn();
        const editor = createEditorWithMenuTrigger('', callback);

        editor.setEditable(false);
        callback.mockClear();

        editor.commands.setContent('<p>/</p>');
        editor.commands.setTextSelection(2);

        // When not editable, the callback should emit null (or not fire with a non-null state)
        const nonNullCalls = callback.mock.calls.filter((c) => c[0] !== null);
        expect(nonNullCalls.length).toBe(0);
    });

    it('routes slash menu navigation keys while the editor keeps focus', () => {
        const callback = vi.fn();
        const keyCallback = vi.fn(() => true);
        const editor = createEditorWithMenuTrigger('', callback, keyCallback);

        editor.commands.setContent('<p>/heading</p>');
        editor.commands.setTextSelection(9);
        vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(false);

        const handled = editor.view.someProp('handleKeyDown', (handler) =>
            handler(editor.view, new KeyboardEvent('keydown', { key: 'ArrowDown' })),
        );

        expect(handled).toBe(true);
        expect(keyCallback).toHaveBeenCalledWith(expect.objectContaining({
            key: 'ArrowDown',
            trigger: expect.objectContaining({
                kind: 'slash',
                query: 'heading',
            }),
        }));
    });

    it('does not route slash menu keys during IME composition', () => {
        const callback = vi.fn();
        const keyCallback = vi.fn(() => true);
        const editor = createEditorWithMenuTrigger('', callback, keyCallback);

        editor.commands.setContent('<p>/heading</p>');
        editor.commands.setTextSelection(9);
        vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(false);
        Object.defineProperty(editor.view, 'composing', {
            configurable: true,
            value: true,
        });

        editor.view.someProp('handleKeyDown', (handler) =>
            handler(editor.view, new KeyboardEvent('keydown', { key: 'Enter' })),
        );

        expect(keyCallback).not.toHaveBeenCalled();
    });
});
