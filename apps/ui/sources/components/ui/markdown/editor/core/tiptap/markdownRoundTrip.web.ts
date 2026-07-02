/**
 * Web-only markdown round-trip used by the rich-eligibility gate.
 *
 * The gate (`core/eligibility/markdownRichEligibility.ts`) is pure and takes an
 * injected `htmlRoundTrip` adapter. On web we inject THIS implementation: it runs
 * the markdown through a throwaway headless `@tiptap/core` `Editor`
 * (element-less, `contentType: 'markdown'`) and reads it back via
 * `editor.getMarkdown()`. Using a real `Editor` (rather than the manager alone)
 * means the round-trip reflects exactly what the live editor would serialize,
 * mirroring Orca's verified throwaway-editor approach (plan §5.3).
 *
 * Returns the re-serialized markdown, or `null` if the round-trip throws (which
 * the gate treats as "not preserved" -> raw fallback).
 *
 * R18: imports `@tiptap/*` and therefore lives in `core/tiptap/`. It is consumed
 * by `core/eligibility/richEligibility.web.ts` (the only `core/eligibility/`
 * file allowed to reach into `core/tiptap/`).
 */

import { Editor } from '@tiptap/core';

import { createBoundedFifoCache, hashContent } from '../eligibility/_shared';
import { encodeRiskyMarkdown } from '../eligibility/encodeRiskyMarkdown';
import { createMarkdownEditorExtensions } from './createMarkdownEditorExtensions';

// --- Bounded content-hash cache (FIFO, ~20 entries) -------------------------
// Hashing + bounded FIFO eviction live in `core/eligibility/_shared.ts` so this
// round-trip cache and the eligibility cache stay byte-identical (change both
// together). `_shared.ts` is pure (no `@tiptap`), so importing it here is safe.

const MAX_CACHE_ENTRIES = 20;
const roundTripCache = createBoundedFifoCache<string | null>(MAX_CACHE_ENTRIES);

function remember(key: string, result: string | null): string | null {
    return roundTripCache.set(key, result);
}

/**
 * Round-trips `body` markdown through a throwaway editor: markdown -> doc ->
 * markdown. Returns `null` on failure.
 */
export function getRichMarkdownRoundTripOutput(body: string): string | null {
    const key = hashContent(body);
    if (roundTripCache.has(key)) {
        return roundTripCache.get(key) ?? null;
    }

    let editor: Editor | null = null;
    try {
        editor = new Editor({
            // Element-less: never mounted into the DOM (R-A11 keeps this web-only).
            element: null,
            extensions: createMarkdownEditorExtensions(),
            // Encode-on-input: the risky-markdown pre-pass rewrites raw HTML /
            // comments to sentinels so the raw-HTML atom nodes can round-trip them
            // verbatim. Without this, the throwaway editor sees un-encoded HTML and
            // the round-trip drops it (the gate would then block the document).
            content: encodeRiskyMarkdown(body),
            contentType: 'markdown',
        });
        const output = editor.getMarkdown();
        return remember(key, typeof output === 'string' ? output : null);
    } catch {
        return remember(key, null);
    } finally {
        if (editor) {
            try {
                editor.destroy();
            } catch {
                // Best-effort teardown; ignore.
            }
        }
    }
}
