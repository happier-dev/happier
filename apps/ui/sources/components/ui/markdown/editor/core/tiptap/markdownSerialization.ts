/**
 * Markdown <-> ProseMirror-doc serialization for the rich markdown editor.
 *
 * Built on `@tiptap/markdown`'s `MarkdownManager`, which is fully DOM-free: it
 * uses `marked` to parse markdown into TipTap JSON (`parse`) and renders TipTap
 * JSON back to markdown (`serialize`). This means the same helpers work in:
 *  - the React web surface (alongside a live `Editor`),
 *  - the headless `@tiptap/core` WebView bundle entry, and
 *  - the throwaway round-trip used by the web eligibility gate.
 *
 * R18: imports `@tiptap/*` and therefore lives in `core/tiptap/` only.
 */

import type { JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';

import { encodeRiskyMarkdown } from '../eligibility/encodeRiskyMarkdown';
import { createMarkdownEditorExtensions } from './createMarkdownEditorExtensions';

/**
 * A reusable manager built from the Phase-1 extension set. Constructing the
 * manager resolves the schema once; reusing it keeps parse/serialize cheap.
 *
 * Lazily created so importing this module has no upfront cost and so callers in
 * environments without the extensions loaded never pay for it until used.
 */
let sharedManager: MarkdownManager | null = null;

function getManager(): MarkdownManager {
    if (sharedManager === null) {
        sharedManager = new MarkdownManager({
            extensions: createMarkdownEditorExtensions(),
        });
    }
    return sharedManager;
}

/**
 * Parses a markdown string into a TipTap JSON document.
 *
 * Use this to seed an `Editor` (or as the parse half of a round-trip). The
 * returned value is a `doc` node suitable for `Editor` `content` /
 * `setContent`.
 *
 * The risky-markdown pre-pass (`encodeRiskyMarkdown`) runs FIRST so embedded raw
 * HTML / HTML comments are rewritten to sentinels and parsed into byte-verbatim
 * atom nodes (Phase-1.5). This is the centralized encode-on-input boundary for
 * every doc/round-trip parse path (the web surface seeds via `markdownToDoc`, so
 * it is covered here for free). Serialize (`docToMarkdown`) must NOT encode — the
 * atom nodes already re-emit the original bytes verbatim, so double-encoding it
 * would corrupt the output.
 */
export function markdownToDoc(markdown: string): JSONContent {
    return getManager().parse(encodeRiskyMarkdown(markdown));
}

/**
 * Serializes a TipTap JSON document back to a markdown string.
 *
 * Use this for `getValue()` on the web surface (serialize the live doc) and as
 * the serialize half of a round-trip.
 */
export function docToMarkdown(doc: JSONContent): string {
    return getManager().serialize(doc);
}

/**
 * Round-trips a markdown string through parse -> serialize using the shared
 * manager. Returns the re-serialized markdown.
 *
 * This is the DOM-free primitive the web eligibility round-trip builds on. It
 * does NOT need a mounted editor (no DOM), so it is safe anywhere `@tiptap/*`
 * may be imported.
 *
 * Goes through `markdownToDoc` for the parse half so the risky-markdown pre-pass
 * runs (raw HTML / comments → byte-verbatim atoms). Serialize then re-emits the
 * original bytes verbatim, so a clean document round-trips losslessly — exactly
 * the property the eligibility gate's `preservesEmbeddedHtml` check depends on.
 */
export function roundTripMarkdown(markdown: string): string {
    return getManager().serialize(markdownToDoc(markdown));
}
