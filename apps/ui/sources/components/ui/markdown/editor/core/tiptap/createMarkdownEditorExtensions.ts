/**
 * Phase-1 TipTap extension set for the rich markdown editor.
 *
 * Framework-agnostic: this returns plain `@tiptap/core` extension instances with
 * NO React node views (D4), so it is consumed identically by the `@tiptap/react`
 * web surface and the headless `@tiptap/core` WebView bundle entry.
 *
 * Phase-1 scope (R-A9): headings (H1-H3), bold/italic/strike/inline-code,
 * bullet/ordered/task lists, blockquote, fenced code block, horizontal rule, and
 * links. Links are creation-by-autolink/paste only (R-A13) — there is NO
 * insert-link UI in Phase 1; the toolbar can only unlink/open an existing link.
 *
 * Deliberately EXCLUDED in Phase 1: tables, math, mermaid, images, the slash
 * menu, placeholder (no `@tiptap/extension-placeholder`, R-A20), and the
 * `underline` mark (StarterKit ships it but plain markdown has no underline
 * syntax, so it would not round-trip — disabled to keep the gate's idempotency
 * contract honest).
 *
 * R18: this file lives in `core/tiptap/` and is the only place (besides the web
 * surface + bundle entry) allowed to import `@tiptap/*`.
 */

import type { AnyExtension } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import { StarterKit } from '@tiptap/starter-kit';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';

import { ListContinuation } from './listContinuation';
import { MenuTriggerExtension } from './menuTriggerExtension';
import type { MenuTriggerKeyDownEvent, MenuTriggerState } from './menuTriggerExtensionTypes';
import { NormalizeSoftBreaks } from './normalizeSoftBreaks';
import {
    RawMarkdownHtmlBlock,
    RawMarkdownHtmlInline,
} from './rawMarkdownHtmlNodes';

/** Heading levels offered in Phase 1 (H1-H3 only). */
export const MARKDOWN_EDITOR_HEADING_LEVELS: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];

/** Options for configuring the extension set with host-provided callbacks. */
export type CreateMarkdownEditorExtensionsOptions = Readonly<{
    /**
     * Called when the slash-command trigger state changes.
     * When `null`, the `MenuTriggerExtension` is still registered but its
     * callback is a no-op (avoids conditional extension lists that would
     * change the schema shape).
     */
    onMenuTriggerChange?: ((state: MenuTriggerState | null) => void) | null;
    /**
     * Called when the editor receives a slash-menu navigation/commit/dismiss key
     * while a trigger is active. Returning true consumes the editor key.
     */
    onMenuTriggerKeyDown?: ((event: MenuTriggerKeyDownEvent) => boolean) | null;
}>;

/**
 * Builds the ordered Phase-1 extension list for a TipTap `Editor`.
 *
 * The list is framework-agnostic and order-stable so the schema is identical on
 * web and inside the WebView bundle (and so `@tiptap/markdown` resolves the same
 * mark priorities in both — link priority 1000 stays outermost).
 */
export function createMarkdownEditorExtensions(
    options?: CreateMarkdownEditorExtensionsOptions,
): AnyExtension[] {
    return [
        StarterKit.configure({
            // H1-H3 only (Phase-1 scope).
            heading: { levels: [...MARKDOWN_EDITOR_HEADING_LEVELS] },
            // Preserve + autolink + paste-to-link; never auto-open inside the editor
            // (the toolbar drives open/unlink). No insert-link dialog in Phase 1.
            link: {
                openOnClick: false,
                autolink: true,
                linkOnPaste: true,
            },
            // No plain-markdown underline syntax -> disable so round-trip stays lossless.
            underline: false,
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        // Byte-verbatim raw-HTML atoms (Phase-1.5). Registered BEFORE `Markdown`
        // so their `markdownTokenizer`s are wired into the manager and their
        // sentinel tokens are recognized during parse. They round-trip raw HTML /
        // HTML comments losslessly (paired with the `encodeRiskyMarkdown` pre-pass
        // that runs at every parse/seed boundary).
        RawMarkdownHtmlInline,
        RawMarkdownHtmlBlock,
        // Adds markdown parse/serialize (`editor.getMarkdown()`,
        // `editor.storage.markdown.manager`, and `contentType: 'markdown'`).
        Markdown,
        // Plain extensions (no nodes/marks) registered AFTER the markdown
        // manager. Order matters for two reasons:
        //   1. Nodes/marks must be declared before plugins/keymaps so the
        //      schema is fully resolved when the keymap runs (mirrors Orca's
        //      "data nodes → behavior plugins" ordering).
        //   2. NormalizeSoftBreaks's `onCreate` runs the post-parse paragraph
        //      split after `@tiptap/markdown` has populated the doc.
        NormalizeSoftBreaks,
        ListContinuation,
        // Slash-command trigger detection (Lane F). Registered after all
        // node/mark extensions so the schema is fully resolved when the
        // `onUpdate`/`onSelectionUpdate` callbacks run. The callback is a
        // no-op when not provided — avoids conditional extension lists.
        MenuTriggerExtension.configure({
            onMenuTriggerChange: options?.onMenuTriggerChange ?? (() => {}),
            onMenuTriggerKeyDown: options?.onMenuTriggerKeyDown ?? (() => false),
        }),
    ];
}
