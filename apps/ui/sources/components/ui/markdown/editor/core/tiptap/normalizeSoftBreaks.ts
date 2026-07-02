/**
 * Post-parse normalization for the rich markdown editor.
 *
 * Why: the `marked` parser (with `breaks: false`, the default that `@tiptap/markdown`
 * configures) treats consecutive lines without a blank separator as a single
 * paragraph carrying LITERAL `\n` characters in the text content (e.g. "Line one\n
 * Line two\nLine three"). Those `\n` chars are invisible in the rendered HTML
 * (CSS `white-space` collapsing), but they make block-level ops behave wrong —
 * a cut/Enter/selection over "one line" actually grabs the entire multi-line
 * paragraph, because to ProseMirror the whole thing is a single block.
 *
 * This module:
 *   - Exports the imperative `normalizeSoftBreaks(editor)` function (a faithful
 *     port from Orca's `rich-markdown-normalize.ts`) — testable in isolation and
 *     callable from the canonical seed boundary (`seedMarkdown`).
 *   - Exports the `NormalizeSoftBreaks` TipTap extension which runs the same
 *     normalization on `onCreate` (so initial `content: 'markdown'` constructor
 *     seeding is covered without callers having to remember to invoke it).
 *
 * The transaction is dispatched with `addToHistory: false` because this is
 * structural housekeeping, NOT a user edit — it must not pollute the undo stack.
 *
 * R18: imports `@tiptap/*`, so it MUST live in `core/tiptap/` (never
 * `core/eligibility/`) and MUST NOT be imported from any native-graph file
 * (`MarkdownEditor.native.tsx` / native surfaces / `core/eligibility/**`).
 */

import { Extension, type Editor } from '@tiptap/core';
import { Fragment, type Node as PmNode } from '@tiptap/pm/model';

type SoftBreakReplacement =
    | {
        kind: 'soft-break-paragraphs';
        from: number;
        to: number;
        paragraphs: Fragment[];
    }
    | {
        kind: 'empty-list-item';
        from: number;
        to: number;
        node: PmNode;
    };

/**
 * Walks the doc and splits any paragraph whose text content contains literal
 * `\n` chars into one paragraph per line (preserving inline marks), and gives
 * empty `listItem`s (which `marked` emits for `3. ` immediately before a
 * heading) a paragraph caret target.
 *
 * Safe to call repeatedly: when no paragraph contains a `\n` and no empty list
 * items exist, the function early-exits without dispatching a transaction
 * (idempotent on already-clean documents).
 */
export function normalizeSoftBreaks(editor: Editor): void {
    // Read from `editor.view.state` rather than `editor.state` so the doc we
    // traverse and the transaction we later create share the same base state.
    // After `setContent(...)`, `editor.state` can lag behind the last React
    // render while `editor.view.state` always reflects the latest document.
    const { doc, schema } = editor.view.state;
    const paragraphType = schema.nodes.paragraph;
    if (!paragraphType) {
        return;
    }

    // Collect replacements across the ENTIRE document tree, not just top-level
    // nodes. `doc.forEach` only iterates direct children, so paragraphs nested
    // inside blockquotes / table cells / list items would be missed.
    // `doc.descendants` walks every node at every depth with absolute positions.
    const replacements: SoftBreakReplacement[] = [];

    doc.descendants((node, pos) => {
        if (node.type.name === 'listItem' && node.childCount === 0) {
            // `marked` parses `3. ` immediately before a heading as a list item
            // with NO paragraph child. It renders a marker but offers no
            // editable caret target — give it an empty paragraph so the caret
            // can land there.
            replacements.push({
                kind: 'empty-list-item',
                from: pos,
                to: pos + node.nodeSize,
                node: node.type.create(node.attrs, paragraphType.create(), node.marks),
            });
            return false;
        }

        if (node.type !== paragraphType) {
            return true; // keep descending into container nodes
        }
        if (!node.textContent.includes('\n')) {
            return false; // no soft breaks → no need to descend into inline content
        }

        // Build an array of Fragment contents — one per output paragraph.
        // We walk the paragraph's inline content, splitting text nodes on `\n`
        // while preserving marks on every piece.
        const lines: Fragment[] = [];
        let currentNodes: PmNode[] = [];

        node.content.forEach((child) => {
            if (!child.isText || !child.text?.includes('\n')) {
                currentNodes.push(child);
                return;
            }

            // Split this text node on `\n`. Each segment inherits the marks of
            // the original text node.
            const parts = child.text.split('\n');
            parts.forEach((part, i) => {
                if (i > 0) {
                    // Flush `currentNodes` into a completed line.
                    lines.push(Fragment.from(currentNodes));
                    currentNodes = [];
                }
                if (part.length > 0) {
                    currentNodes.push(schema.text(part, child.marks));
                }
            });
        });

        // Flush the last accumulated line.
        lines.push(Fragment.from(currentNodes));

        // Only replace if we actually split into multiple paragraphs.
        if (lines.length <= 1) {
            return false;
        }

        replacements.push({
            kind: 'soft-break-paragraphs',
            from: pos,
            to: pos + node.nodeSize,
            paragraphs: lines,
        });

        return false; // paragraph's inline children don't need further traversal
    });

    if (replacements.length === 0) {
        return;
    }

    // Capture the transaction AFTER all replacements are collected so we work
    // from a single base state.
    const tr = editor.view.state.tr;

    // Apply replacements in reverse document order so each replacement's `from`
    // remains valid as later (higher-position) replacements are applied first.
    replacements.sort((a, b) => b.from - a.from);
    for (const replacement of replacements) {
        if (replacement.kind === 'empty-list-item') {
            tr.replaceWith(replacement.from, replacement.to, replacement.node);
            continue;
        }
        const newNodes = replacement.paragraphs.map((content) =>
            paragraphType.create(null, content),
        );
        tr.replaceWith(replacement.from, replacement.to, newNodes);
    }

    // Structural housekeeping, NOT a user edit — keep it off the undo stack.
    editor.view.dispatch(tr.setMeta('addToHistory', false));
}

/**
 * TipTap extension that runs `normalizeSoftBreaks` on editor `onCreate`.
 *
 * Wiring this as an extension lets `createMarkdownEditorExtensions` cover the
 * "initial content" path (when an `Editor` is constructed with
 * `content: <markdown>, contentType: 'markdown'`) without callers needing to
 * remember to call the function. The shared seed helper (`seedMarkdown`) calls
 * the same function imperatively, so the `setContent`-after-mount path stays
 * covered too.
 */
export const NormalizeSoftBreaks = Extension.create({
    name: 'normalizeSoftBreaks',

    onCreate() {
        normalizeSoftBreaks(this.editor);
    },
});
