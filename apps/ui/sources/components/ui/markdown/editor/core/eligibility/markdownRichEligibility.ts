/**
 * Layered rich-eligibility gate (cheap-check-first), modeled on Orca's
 * `markdown-rich-mode.ts` (verified 2026-05-23).
 *
 * The #1 correctness risk for a rich markdown *file* editor is a lossy/
 * non-idempotent markdown round-trip silently rewriting the user's file. This
 * gate cheaply blocks constructs TipTap can't faithfully round-trip and only
 * admits files that survive — so opening Rich + saving without edits stays a
 * no-op (combined with no-dirty-on-mount, R-A7).
 *
 * PURE — NO `@tiptap/*` import anywhere (R18). The (web-only) expensive HTML
 * round-trip is supplied as an injected `htmlRoundTrip` adapter; native injects
 * none, conservatively blocking HTML-containing markdown (R16).
 */

import { createBoundedFifoCache, hashContent } from './_shared';
import { extractFrontMatter } from './markdownFrontmatter';
import { stripMarkdownCode } from './stripMarkdownCode';

export type MarkdownRichIneligibleReason =
    | 'mdx'
    | 'too-large'
    | 'reference-links'
    | 'footnotes'
    | 'html-or-jsx';

export type MarkdownRichEligibility = Readonly<{
    eligible: boolean;
    reason?: MarkdownRichIneligibleReason;
}>;

export type EvaluateMarkdownRichEligibilityOptions = Readonly<{
    /** Detected language for the file (`'markdown'` for plain `.md`; `'mdx'`/other → blocked). */
    language: string | null;
    /** Body byte budget for offering rich at all (`filesMarkdownRichEditorMaxBytes`). */
    maxBytes: number;
    /** Body byte budget below which the expensive HTML round-trip runs (`…HtmlRoundTripMaxBytes`). */
    htmlRoundTripMaxBytes: number;
    /**
     * Web-only round-trip adapter (throwaway `@tiptap/core` serialize→parse→serialize).
     * Returns the round-tripped markdown, or `null` if the round-trip failed.
     * When omitted (native), HTML-containing markdown is conservatively blocked.
     */
    htmlRoundTrip?: (body: string) => string | null;
}>;

// Reference-link definitions: `[label]: target` at the start of a line.
const REFERENCE_LINK_PATTERN = /^\[[^\]]+\]:\s+\S+/m;
// Footnote definitions: `[^id]: text` at the start of a line.
const FOOTNOTE_PATTERN = /^\[\^[^\]]+\]:\s+/m;
// Any HTML/JSX tag or HTML comment.
const HTML_PATTERN = /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/;
// Global variant used to enumerate every embedded HTML fragment for preservation checks.
const HTML_GLOBAL_PATTERN = /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g;

const sharedTextEncoder = new TextEncoder();

/** UTF-8 byte length of a string. */
function byteLen(value: string): number {
    return sharedTextEncoder.encode(value).length;
}

/**
 * Verifies that every embedded HTML fragment in `probe` survives the round-trip,
 * appearing in `roundTripOutput` in the same relative order (Orca's
 * `preservesEmbeddedHtml`). Ordered-substring presence catches dropped/reordered
 * HTML even if the serializer escapes surrounding markdown differently.
 */
export function preservesEmbeddedHtml(probe: string, roundTripOutput: string | null): boolean {
    if (roundTripOutput === null) {
        return false;
    }

    const fragments = probe.match(HTML_GLOBAL_PATTERN);
    if (!fragments || fragments.length === 0) {
        return true;
    }

    let searchFrom = 0;
    for (const fragment of fragments) {
        const found = roundTripOutput.indexOf(fragment, searchFrom);
        if (found === -1) {
            return false;
        }
        searchFrom = found + fragment.length;
    }
    return true;
}

// --- Bounded content-hash cache (FIFO, ~20 entries; lighter than Orca's raw-string key) ---
// Hashing + bounded FIFO eviction live in `_shared.ts` so the eligibility cache
// and the round-trip cache (`core/tiptap/markdownRoundTrip.web.ts`) stay identical.

const MAX_CACHE_ENTRIES = 20;
const eligibilityCache = createBoundedFifoCache<MarkdownRichEligibility>(MAX_CACHE_ENTRIES);

function cacheKey(raw: string, opts: EvaluateMarkdownRichEligibilityOptions): string {
    // Key on the inputs that change the verdict, including whether an adapter is
    // present (web vs native) so the two platforms never share a cached result.
    const adapter = opts.htmlRoundTrip ? '1' : '0';
    return `${opts.language ?? 'null'}|${opts.maxBytes}|${opts.htmlRoundTripMaxBytes}|${adapter}|${hashContent(raw)}`;
}

function rememberResult(key: string, result: MarkdownRichEligibility): MarkdownRichEligibility {
    return eligibilityCache.set(key, result);
}

const ELIGIBLE: MarkdownRichEligibility = { eligible: true };

/**
 * Evaluates whether `raw` markdown can be safely rich-edited. Cheap checks run
 * first; the expensive HTML round-trip runs last and only on web within budget.
 *
 * @see §5.3 of the unification plan for the verified ordering.
 */
export function evaluateMarkdownRichEligibility(
    raw: string,
    opts: EvaluateMarkdownRichEligibilityOptions,
): MarkdownRichEligibility {
    const key = cacheKey(raw, opts);
    const cached = eligibilityCache.get(key);
    if (cached) {
        return cached;
    }

    // 1) `.md`-only (R-A1): anything else (`.mdx`, etc.) is raw/preview-only.
    if (opts.language !== 'markdown') {
        return rememberResult(key, { eligible: false, reason: 'mdx' });
    }

    // 2) Strip frontmatter; eligibility is decided on the body only.
    const body = extractFrontMatter(raw).body;

    // 3) Size gate (R-A2): too large → route to raw.
    const bodyBytes = byteLen(body);
    if (bodyBytes > opts.maxBytes) {
        return rememberResult(key, { eligible: false, reason: 'too-large' });
    }

    // 4) Remove code regions so examples inside code don't trip the blockers.
    const probe = stripMarkdownCode(body);

    // 5) Footnote definitions FIRST — a footnote def `[^id]:` also matches the
    //    broad reference-link pattern (`[^\]]+` accepts `^id`), so the more
    //    specific footnote check must run before the reference-link check.
    if (FOOTNOTE_PATTERN.test(probe)) {
        return rememberResult(key, { eligible: false, reason: 'footnotes' });
    }

    // 6) Reference-link definitions.
    if (REFERENCE_LINK_PATTERN.test(probe)) {
        return rememberResult(key, { eligible: false, reason: 'reference-links' });
    }

    // 7) HTML/JSX/MDX.
    const hasHtml = HTML_PATTERN.test(probe);
    if (!hasHtml) {
        return rememberResult(key, ELIGIBLE);
    }

    // WEB: run the expensive round-trip only within budget, and only accept it
    // when every embedded HTML fragment is preserved.
    if (opts.htmlRoundTrip && bodyBytes <= opts.htmlRoundTripMaxBytes) {
        const roundTripped = opts.htmlRoundTrip(body);
        if (preservesEmbeddedHtml(probe, roundTripped)) {
            return rememberResult(key, ELIGIBLE);
        }
        return rememberResult(key, { eligible: false, reason: 'html-or-jsx' });
    }

    // NATIVE (no adapter) or over the round-trip budget: conservatively block.
    return rememberResult(key, { eligible: false, reason: 'html-or-jsx' });
}
