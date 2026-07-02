/**
 * TipTap extension that detects slash-command triggers (`/query`) inside the
 * editor and emits a `MenuTriggerState` with the caret rectangle in WebView
 * viewport coordinates.
 *
 * Mirrors Orca's `syncSlashMenu` (~`rich-markdown-commands.tsx:341-383`) as a
 * proper TipTap Extension, subscribed via `onUpdate` + `onSelectionUpdate`.
 *
 * The extension is framework-agnostic (no React) so it works in both the
 * `@tiptap/react` web surface and the headless WebView bundle entry.
 *
 * R18: imports `@tiptap/*` and lives in `core/tiptap/` — only ever bundled
 * into the web / WebView graph, never the native RN JS graph.
 */

import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';

import type { MenuTriggerKey, MenuTriggerKeyDownEvent, MenuTriggerState } from './menuTriggerExtensionTypes';

export type MenuTriggerExtensionOptions = {
    /**
     * Callback invoked whenever the slash trigger state changes.
     * Receives `MenuTriggerState` when active, `null` when dismissed.
     */
    onMenuTriggerChange: (state: MenuTriggerState | null) => void;
    /**
     * Callback invoked from the editor keymap when a slash trigger is active and
     * the editor still owns focus. Returning true consumes the editor key.
     */
    onMenuTriggerKeyDown: (event: MenuTriggerKeyDownEvent) => boolean;
};

/**
 * Regex for the slash trigger: matches a `/` optionally preceded by whitespace
 * at the start of the block, followed by zero or more lowercase-alpha / digit /
 * dash characters (the query).
 */
const SLASH_TRIGGER_REGEX = /^\s*\/([a-z0-9-]*)$/;

function readSlashMenuState(editor: Editor): MenuTriggerState | null {
    const { view, state } = editor;

    // Bail if composing (IME), not editable, or selection is not collapsed.
    if (view.composing || !editor.isEditable) {
        return null;
    }

    const { selection } = state;
    if (!selection.empty) {
        return null;
    }

    const { $from } = selection;
    if (!$from.parent.isTextblock) {
        return null;
    }

    // Get text before cursor in the current block.
    const blockTextBeforeCursor = $from.parent.textBetween(
        0,
        $from.parentOffset,
        '\0',
        '\0',
    );

    const match = blockTextBeforeCursor.match(SLASH_TRIGGER_REGEX);
    if (!match) {
        return null;
    }

    const query = match[1] ?? '';
    const slashOffset = blockTextBeforeCursor.lastIndexOf('/');
    const from = selection.from - ($from.parentOffset - slashOffset);
    const to = selection.from;

    // Compute caret rect in WebView viewport coordinates (D20).
    let caretRect: MenuTriggerState['caretRect'];
    try {
        const coords = view.coordsAtPos(selection.from);
        caretRect = {
            left: coords.left,
            top: coords.top,
            height: coords.bottom - coords.top,
        };
    } catch {
        return null;
    }

    return {
        kind: 'slash',
        query,
        from,
        to,
        caretRect,
    };
}

/**
 * Runs the slash-menu sync predicate against the current editor state.
 * Mirrors Orca's `syncSlashMenu` logic.
 */
function syncSlashMenu(
    editor: Editor,
    callback: (state: MenuTriggerState | null) => void,
): void {
    callback(readSlashMenuState(editor));
}

function routeSlashMenuKey(
    editor: Editor,
    key: MenuTriggerKey,
    callback: (event: MenuTriggerKeyDownEvent) => boolean,
): boolean {
    const trigger = readSlashMenuState(editor);
    if (!trigger) {
        return false;
    }
    return callback({ key, trigger }) === true;
}

/**
 * TipTap Extension that detects slash triggers and emits menu trigger state.
 *
 * Configure with `onMenuTriggerChange` callback:
 * ```ts
 * MenuTriggerExtension.configure({
 *     onMenuTriggerChange: (state) => { ... },
 * })
 * ```
 */
export const MenuTriggerExtension = Extension.create<MenuTriggerExtensionOptions>({
    name: 'menuTrigger',
    priority: 1000,

    addOptions() {
        return {
            onMenuTriggerChange: () => {},
            onMenuTriggerKeyDown: () => false,
        };
    },

    onUpdate() {
        syncSlashMenu(this.editor, this.options.onMenuTriggerChange);
    },

    onSelectionUpdate() {
        syncSlashMenu(this.editor, this.options.onMenuTriggerChange);
    },

    addKeyboardShortcuts() {
        return {
            ArrowDown: () => routeSlashMenuKey(this.editor, 'ArrowDown', this.options.onMenuTriggerKeyDown),
            ArrowUp: () => routeSlashMenuKey(this.editor, 'ArrowUp', this.options.onMenuTriggerKeyDown),
            Enter: () => routeSlashMenuKey(this.editor, 'Enter', this.options.onMenuTriggerKeyDown),
            Tab: () => routeSlashMenuKey(this.editor, 'Tab', this.options.onMenuTriggerKeyDown),
            Escape: () => routeSlashMenuKey(this.editor, 'Escape', this.options.onMenuTriggerKeyDown),
        };
    },
});
