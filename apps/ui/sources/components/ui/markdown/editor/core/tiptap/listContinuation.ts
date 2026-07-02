/**
 * List-continuation helpers + extension for the rich markdown editor.
 *
 * Ported from Orca's `rich-markdown-list-continuation.ts`. Addresses three
 * editor friction points that fall through the StarterKit defaults:
 *
 *   1. Ambiguous `1. ` — Markdown's ordered-list shortcut is also a perfectly
 *      valid character sequence the user might want as literal text. Pressing
 *      Enter on a still-empty top-level ordered list should preserve the typed
 *      `1.` instead of unwrapping the list and erasing the marker.
 *
 *   2. Empty nested ordered item — pressing Enter inside an empty `1.` nested
 *      inside another `1.` is almost always the user asking for a CONTINUATION
 *      line under the parent item, not another numbered sublist.
 *
 *   3. Empty continuation-line Backspace — after creating a continuation
 *      paragraph (case 2), Backspace on the blank line should drop the caret
 *      back into the parent item's text — NOT unwrap the parent list item and
 *      remove its marker.
 *
 * The functions are exported as imperative helpers (testable in isolation +
 * callable from a higher-level key handler that owns input-rule state such as
 * Orca's `typedEmptyOrderedListMarkerRef`). The bundled `ListContinuation`
 * extension wires the unambiguous BACKSPACE behavior into the editor's
 * keyboard shortcuts. The Enter behavior (`commitEmptyOrderedListMarkerAsText`)
 * is NOT wired into a keymap here because it must only fire after the user
 * TYPED `1. ` (vs the toolbar/menu creating an empty list) — a flag the
 * extension does not yet have visibility into. Higher layers may call it
 * directly when that flag is set.
 *
 * R18: imports `@tiptap/*`, so it MUST live in `core/tiptap/` (never
 * `core/eligibility/`) and MUST NOT be imported from any native-graph file.
 */

import { Extension, type Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

type EmptyListItemContext = {
    listDepth: number;
    listItemDepth: number;
};

/**
 * Detects whether the caret is in an empty paragraph that is the FIRST child
 * of a `listItem`. Returns the document depths of the enclosing list / listItem
 * so callers can reason about the surrounding structure.
 */
function getEmptyListItemContext(editor: Editor): EmptyListItemContext | null {
    const { selection } = editor.state;

    if (!(selection instanceof TextSelection) || !selection.empty) {
        return null;
    }

    const { $from } = selection;
    const paragraph = $from.parent;
    if (
        paragraph.type.name !== 'paragraph'
        || paragraph.content.size > 0
        || $from.parentOffset !== 0
    ) {
        return null;
    }

    let listItemDepth = -1;
    for (let depth = $from.depth - 1; depth >= 0; depth -= 1) {
        if ($from.node(depth).type.name === 'listItem') {
            listItemDepth = depth;
            break;
        }
    }

    const listDepth = listItemDepth - 1;
    if (listItemDepth < 0 || listDepth < 0) {
        return null;
    }

    return { listDepth, listItemDepth };
}

/**
 * Pressing Enter on an empty top-level `1.` (which the user TYPED, not
 * toolbar-created) replaces the list with two paragraphs: one carrying the
 * literal `1.` text (so the typed bytes are preserved) and one empty paragraph
 * the caret lands in.
 *
 * Returns `true` when the rewrite happened, `false` when the caller should
 * fall through to the default Enter behavior.
 *
 * Caller contract: only invoke this when you know the user actually TYPED the
 * marker. Calling it for every Enter on an empty `1.` would incorrectly
 * unwrap toolbar-created lists (verified by the ported test cases).
 */
export function commitEmptyOrderedListMarkerAsText(editor: Editor): boolean {
    const context = getEmptyListItemContext(editor);
    if (!context) {
        return false;
    }

    const { state, view } = editor;
    const { schema } = state;
    const { $from } = state.selection;
    const list = $from.node(context.listDepth);
    const listItem = $from.node(context.listItemDepth);
    const parentDepth = context.listDepth - 1;

    if (
        list.type.name !== 'orderedList'
        || list.childCount !== 1
        || listItem.childCount !== 1
        || (parentDepth >= 0 && $from.node(parentDepth).type.name === 'listItem')
    ) {
        return false;
    }

    const paragraphType = schema.nodes.paragraph;
    if (!paragraphType) {
        return false;
    }

    const start = typeof list.attrs.start === 'number' ? list.attrs.start : 1;
    const markerParagraph = paragraphType.create(null, schema.text(`${start}.`));
    const nextParagraph = paragraphType.create();
    const from = $from.before(context.listDepth);
    const to = from + list.nodeSize;
    const tr = state.tr.replaceWith(from, to, [markerParagraph, nextParagraph]);
    // `1. ` is ambiguous: it may be a list shortcut, or literal text. Enter on
    // the still-empty item should preserve what the user typed instead of
    // treating it as an abandoned list and erasing the marker.
    tr.setSelection(TextSelection.create(tr.doc, from + markerParagraph.nodeSize + 1));
    view.dispatch(tr.scrollIntoView());
    return true;
}

/**
 * Returns `true` when the caret is in the SOLE listItem of a top-level (not
 * nested) empty `orderedList`. Used by higher layers as a precondition before
 * deciding whether to invoke `commitEmptyOrderedListMarkerAsText`.
 */
export function isSingleEmptyTopLevelOrderedList(editor: Editor): boolean {
    const context = getEmptyListItemContext(editor);
    if (!context) {
        return false;
    }

    const { $from } = editor.state.selection;
    const list = $from.node(context.listDepth);
    const listItem = $from.node(context.listItemDepth);
    const parentDepth = context.listDepth - 1;
    return (
        list.type.name === 'orderedList'
        && list.childCount === 1
        && listItem.childCount === 1
        && !(parentDepth >= 0 && $from.node(parentDepth).type.name === 'listItem')
    );
}

/**
 * Backspace on an empty continuation paragraph (a blank paragraph that sits
 * AFTER a non-empty paragraph inside the same ordered list item) drops the
 * caret back into the parent item's text — NOT unwrapping the list / removing
 * the marker, which is what the default Backspace would do.
 *
 * Returns `true` when the rewrite happened, `false` when the caller should
 * fall through to the default Backspace behavior.
 */
export function collapseEmptyListContinuationParagraph(editor: Editor): boolean {
    const context = getEmptyListItemContext(editor);
    if (!context) {
        return false;
    }

    const { state, view } = editor;
    const { $from } = state.selection;
    const list = $from.node(context.listDepth);
    const listItem = $from.node(context.listItemDepth);
    const childIndex = $from.index(context.listItemDepth);

    if (list.type.name !== 'orderedList' || childIndex <= 0) {
        return false;
    }

    const previousChild = listItem.child(childIndex - 1);
    if (previousChild.type.name !== 'paragraph' || previousChild.content.size === 0) {
        return false;
    }

    const from = $from.before($from.depth);
    const to = $from.after($from.depth);
    const previousParagraphEnd = from - 1;
    const tr = state.tr.delete(from, to);
    // After backing out of a nested list, Backspace on the blank continuation
    // line should return to the parent item's text, not unwrap the numbered
    // list item and remove its marker.
    tr.setSelection(TextSelection.create(tr.doc, previousParagraphEnd));
    view.dispatch(tr.scrollIntoView());
    return true;
}

/**
 * Backspace inside an empty NESTED ordered item replaces the nested list with
 * an empty paragraph inside the parent item — turning "another nested numbered
 * sublist with nothing in it" into "a blank continuation line under the parent
 * item", which is almost always what the user wants.
 *
 * Returns `true` when the rewrite happened, `false` when the caller should
 * fall through to the default Backspace behavior.
 */
export function convertEmptyNestedOrderedItemToContinuation(editor: Editor): boolean {
    const context = getEmptyListItemContext(editor);
    if (!context) {
        return false;
    }

    const { state, view } = editor;
    const { schema } = state;
    const { $from } = state.selection;
    const parentListItemDepth = context.listItemDepth - 2;
    if (parentListItemDepth < 0) {
        return false;
    }

    const list = $from.node(context.listDepth);
    const parentListItem = $from.node(parentListItemDepth);
    if (list.type.name !== 'orderedList' || parentListItem.type.name !== 'listItem') {
        return false;
    }

    if (list.childCount !== 1) {
        return false;
    }

    const replacementParagraph = schema.nodes.paragraph?.create();
    if (!replacementParagraph) {
        return false;
    }

    const from = $from.before(context.listDepth);
    const to = from + list.nodeSize;
    const tr = state.tr.replaceWith(from, to, replacementParagraph);
    // An empty nested ordered item is usually the user asking for a
    // continuation line under the parent item, not another numbered sublist.
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
    view.dispatch(tr.scrollIntoView());
    return true;
}

/**
 * TipTap extension that wires the UNAMBIGUOUS Backspace behavior into the
 * editor's keyboard shortcuts.
 *
 * Backspace order matches Orca: try the "convert empty nested item to
 * continuation" first, then the "collapse empty continuation paragraph"
 * fall-back. Either consumes the keystroke (returns `true`); otherwise we
 * return `false` so the default Backspace handlers run.
 *
 * Enter is NOT wired here. `commitEmptyOrderedListMarkerAsText` is exported as
 * a standalone function for the higher-level key handler that knows whether
 * the empty ordered list was TYPED vs toolbar-created (the disambiguation is
 * impossible at the pure ProseMirror layer).
 */
export const ListContinuation = Extension.create({
    name: 'listContinuation',

    addKeyboardShortcuts() {
        return {
            Backspace: () => {
                const { editor } = this;
                if (convertEmptyNestedOrderedItemToContinuation(editor)) {
                    return true;
                }
                if (collapseEmptyListContinuationParagraph(editor)) {
                    return true;
                }
                return false;
            },
        };
    },
});
