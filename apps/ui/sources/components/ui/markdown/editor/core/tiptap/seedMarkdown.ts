/**
 * The single, canonical way to seed a live TipTap `Editor` from a markdown
 * string for the rich markdown editor.
 *
 * Why this exists: the risky-markdown pre-pass (`encodeRiskyMarkdown`) MUST run
 * at EVERY parse/seed boundary, or raw HTML / HTML comments on the un-encoded
 * path silently fail to round-trip (the encode/decode asymmetry that is the #1
 * correctness risk for this feature). Multiple surfaces seed editors via
 * `setContent(..., { contentType: 'markdown' })`:
 *  - the headless WebView bundle entry (`bridge/tiptapWebViewEntry.ts`) on
 *    `init` and `setDoc`,
 *  - (the web surface seeds via `markdownToDoc`, which encodes internally).
 *
 * Routing those `setContent` calls through this one helper means the encode can
 * never be forgotten on one platform: there is exactly one place that turns a
 * markdown string into editor content via `setContent`, and it always encodes
 * first. (The doc-/round-trip parse path goes through `markdownToDoc`, which
 * encodes internally; this helper is the live-editor `setContent` analogue.)
 *
 * Serialize is UNAFFECTED: the raw-HTML atom nodes re-emit the decoded bytes
 * verbatim, so `editor.getMarkdown()` already returns the original markdown — it
 * must NOT be re-encoded.
 *
 * R18: imports `@tiptap/*`, so it lives in `core/tiptap/`.
 */

import type { Editor } from '@tiptap/core';

import { encodeRiskyMarkdown } from '../eligibility/encodeRiskyMarkdown';
import { normalizeSoftBreaks } from './normalizeSoftBreaks';
import { runWithPreservedTiptapViewState } from './preserveTiptapViewState';

/**
 * Seeds `editor` from a markdown string, applying the risky-markdown pre-pass
 * first so embedded raw HTML / HTML comments become byte-verbatim atom nodes.
 *
 * This is a thin wrapper over `editor.commands.setContent(encoded, {
 * contentType: 'markdown' })` — use it everywhere a live editor is seeded from
 * markdown so the encode is never skipped.
 */
export type SeedMarkdownOptions = Readonly<{
    /** Preserve caret/scroll across host-applied external document replacement. */
    preserveViewState?: boolean;
}>;

export function seedMarkdown(editor: Editor, markdown: string, options?: SeedMarkdownOptions): void {
    const applySeed = () => {
        editor.commands.setContent(encodeRiskyMarkdown(markdown), { contentType: 'markdown' });
        // Mirror Orca's setContent path: re-run the post-parse paragraph split so
        // multi-line paragraphs emitted by `marked` become per-line blocks for
        // block ops (cut/Enter/selection). Idempotent on already-clean docs.
        normalizeSoftBreaks(editor);
    };

    if (options?.preserveViewState === true) {
        runWithPreservedTiptapViewState(editor, applySeed);
        return;
    }

    applySeed();
}
