/**
 * Risky-markdown placeholder-token pre-pass (Phase-1.5).
 *
 * The rich markdown editor's Phase-1 schema has no node that can faithfully
 * round-trip raw HTML or HTML comments, so any document containing them used to
 * be forced to the whole-document raw fallback by the eligibility gate. This
 * module is the FIRST half of Orca's two-part fix (verified vs
 * `/tmp/orca-analysis/.../raw-markdown-html.ts`, 2026-05-24): a pure,
 * single-pass scanner that rewrites each "risky" run (inline HTML, block-only
 * HTML, HTML comments) into an opaque placeholder sentinel BEFORE the markdown
 * parser ever sees it. A companion pair of TipTap atom nodes
 * (`core/tiptap/rawMarkdownHtmlNodes.ts`) then tokenizes those sentinels back
 * into byte-verbatim nodes and re-emits the original bytes on serialize, so the
 * round-trip is lossless and the gate admits the document.
 *
 * Phase-1.5 scope: raw HTML (inline + block) + HTML comments ONLY. Wiki-links /
 * doc-links are deliberately DEFERRED (we have no doc index/resolution layer).
 *
 * Encode/decode contract (THE #1 correctness risk — keep this exact):
 *  - The payload is `encodeURIComponent(raw)`. This is LOAD-BEARING: it ensures
 *    the raw HTML can never contain the `]]` suffix and close the sentinel
 *    early, and it round-trips byte-for-byte via `decodeURIComponent`.
 *  - The sentinel is only ever introduced by `encodeRiskyMarkdown`; the node's
 *    `renderMarkdown` re-emits the DECODED bytes verbatim (NOT the sentinel), so
 *    serialize output is the original markdown and needs NO decode pass.
 *  - `encodeRiskyMarkdown` therefore must run at EVERY parse/seed boundary, and
 *    must NEVER run on serialize output (that would double-encode).
 *  - Re-encoding is guarded: an existing `[[HAPPIER_` sentinel run is copied
 *    verbatim so encoding is idempotent.
 *
 * PURE — NO `@tiptap/*` import (R18). This file lives in the native-reachable
 * `core/eligibility/` graph, so the `noTiptapInNativeGraph` guard must stay
 * green; the encoder is plain regex/string work only.
 */

/** Sentinel prefix for an inline raw-HTML run (URI-encoded payload follows). */
export const RAW_HTML_INLINE_PLACEHOLDER_PREFIX = '[[HAPPIER_RAW_HTML_INLINE:';
/** Sentinel prefix for a block-only raw-HTML line (URI-encoded payload follows). */
export const RAW_HTML_BLOCK_PLACEHOLDER_PREFIX = '[[HAPPIER_RAW_HTML_BLOCK:';
/** Sentinel terminator. Safe because the payload is URI-encoded (no literal `]]`). */
export const RAW_HTML_PLACEHOLDER_SUFFIX = ']]';

/**
 * The common sentinel namespace prefix. Used as the re-encode guard: a run that
 * already starts with this is copied verbatim so encoding is idempotent.
 */
export const RAW_HTML_PLACEHOLDER_NAMESPACE = '[[HAPPIER_';

/** The "risky" placeholder kinds this pre-pass produces. */
export type RiskyMarkdownPlaceholderKind = 'inline' | 'block';

/**
 * Matches an inline HTML run (or HTML comment) anchored at the start of `src`:
 * an HTML comment, or an opening/closing/self-closing tag with optional
 * attributes. Mirrors Orca's `INLINE_HTML_PATTERN`. The attribute body forbids
 * `<`/`>` so a stray `<` does not greedily swallow following markup.
 */
const INLINE_HTML_PATTERN = /^<!--[\s\S]*?-->|^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>/;

/** URI-encodes the raw HTML payload (load-bearing — see module doc). */
function encodeHtmlPayload(raw: string): string {
    return encodeURIComponent(raw);
}

/**
 * Decodes a sentinel payload back to its original bytes. Returns `''` on a
 * malformed payload so a corrupt sentinel degrades to empty rather than throwing
 * (the round-trip gate then rejects it and the document falls back to raw).
 */
function decodeHtmlPayload(payload: string): string {
    try {
        return decodeURIComponent(payload);
    } catch {
        return '';
    }
}

function createPlaceholder(kind: RiskyMarkdownPlaceholderKind, raw: string): string {
    const prefix =
        kind === 'inline'
            ? RAW_HTML_INLINE_PLACEHOLDER_PREFIX
            : RAW_HTML_BLOCK_PLACEHOLDER_PREFIX;
    return `${prefix}${encodeHtmlPayload(raw)}${RAW_HTML_PLACEHOLDER_SUFFIX}`;
}

/**
 * The result of matching a placeholder at the start of `src`:
 * - `placeholder` is the full matched sentinel text (used as the marked `raw`),
 * - `value` is the DECODED original bytes (used as the node's `value` attr).
 */
export type RiskyMarkdownPlaceholderMatch = Readonly<{
    placeholder: string;
    value: string;
}>;

/**
 * Attempts to match a placeholder of `kind` anchored at the START of `src`.
 *
 * Returns `null` when `src` does not begin with the matching prefix or has no
 * terminating `]]`. This is the shared matcher the TipTap tokenizers in
 * `core/tiptap/rawMarkdownHtmlNodes.ts` import — co-located here so the encode
 * and decode halves can never drift apart (single source of truth for the
 * sentinel grammar).
 */
export function matchPlaceholder(
    src: string,
    kind: RiskyMarkdownPlaceholderKind,
): RiskyMarkdownPlaceholderMatch | null {
    const prefix =
        kind === 'inline'
            ? RAW_HTML_INLINE_PLACEHOLDER_PREFIX
            : RAW_HTML_BLOCK_PLACEHOLDER_PREFIX;
    if (!src.startsWith(prefix)) {
        return null;
    }

    const endIndex = src.indexOf(RAW_HTML_PLACEHOLDER_SUFFIX, prefix.length);
    if (endIndex === -1) {
        return null;
    }

    const placeholder = src.slice(0, endIndex + RAW_HTML_PLACEHOLDER_SUFFIX.length);
    const payload = src.slice(prefix.length, endIndex);
    return {
        placeholder,
        value: decodeHtmlPayload(payload),
    };
}

function matchInlineHtml(src: string): string | null {
    const match = src.match(INLINE_HTML_PATTERN);
    return match?.[0] ?? null;
}

/**
 * Returns true when the character at `index` is escaped by an ODD number of
 * immediately-preceding backslashes (markdown's `\<` escape). An even count
 * means the backslashes escape each other and the `<` is live.
 */
function isEscaped(content: string, index: number): boolean {
    let backslashCount = 0;
    for (let i = index - 1; i >= 0 && content[i] === '\\'; i -= 1) {
        backslashCount += 1;
    }
    return backslashCount % 2 === 1;
}

function findLineEnd(content: string, start: number): number {
    const newlineIndex = content.indexOf('\n', start);
    return newlineIndex === -1 ? content.length : newlineIndex;
}

/**
 * True when `line` is ENTIRELY a single HTML tag or HTML comment (ignoring
 * surrounding whitespace). Block-only HTML lines become block sentinels; HTML
 * embedded mid-paragraph is handled by the inline path instead.
 */
function isLineOnlyHtml(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith('<')) {
        return false;
    }

    if (trimmed.startsWith('<!--')) {
        return trimmed.includes('-->');
    }

    return /^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*?)?\/?>$/.test(trimmed);
}

function matchBlockHtml(content: string, start: number): string | null {
    const lineEnd = findLineEnd(content, start);
    const line = content.slice(start, lineEnd);
    if (!isLineOnlyHtml(line)) {
        return null;
    }

    return line;
}

/**
 * Single left-to-right scan over `content` that rewrites risky HTML runs into
 * opaque sentinels while leaving code regions (fenced blocks + inline spans) and
 * backslash-escaped `<` untouched. Mirrors Orca's
 * `encodeRawMarkdownHtmlForRichEditor` (minus the deferred doc-link branch).
 *
 * Ordering inside the loop (mirrors Orca) is significant:
 *  1. Fence tracking (length-aware open/close) — inside a fence, copy verbatim.
 *  2. Inline code span (exact-length backtick close) — copy verbatim.
 *  3. Block-only HTML at line start — emit a block sentinel.
 *  4. Inline HTML (live, unescaped `<`) — emit an inline sentinel.
 *  5. Otherwise copy one character.
 *
 * The existing-sentinel guard lives on the inline `<`/block paths implicitly: a
 * `[[HAPPIER_…]]` run starts with `[`, not `<`, and `isLineOnlyHtml` rejects it,
 * so a previously-encoded document is copied verbatim (idempotent encode).
 */
export function encodeRiskyMarkdown(content: string): string {
    let index = 0;
    let isLineStart = true;
    let activeFence: '`' | '~' | null = null;
    let activeFenceLength = 0;
    let result = '';

    while (index < content.length) {
        const lineRest = content.slice(index);

        if (isLineStart) {
            const fenceMatch = lineRest.match(/^\s*(`{3,}|~{3,})/);
            if (fenceMatch) {
                const fenceChar = fenceMatch[1][0] as '`' | '~';
                const fenceLength = fenceMatch[1].length;
                if (activeFence === null) {
                    activeFence = fenceChar;
                    activeFenceLength = fenceLength;
                } else if (activeFence === fenceChar && fenceLength >= activeFenceLength) {
                    activeFence = null;
                    activeFenceLength = 0;
                }
            }
        }

        if (activeFence) {
            const nextChar = content[index];
            result += nextChar;
            isLineStart = nextChar === '\n';
            index += 1;
            continue;
        }

        if (content[index] === '`') {
            let tickCount = 0;
            while (content[index + tickCount] === '`') {
                tickCount += 1;
            }

            // The closing run must be EXACTLY tickCount backticks (not part of a
            // longer run), so we scan forward for the first exact match.
            let searchFrom = index + tickCount;
            let closingIndex = -1;
            while (searchFrom < content.length) {
                const candidate = content.indexOf('`'.repeat(tickCount), searchFrom);
                if (candidate === -1) {
                    break;
                }
                if (
                    (candidate === 0 || content[candidate - 1] !== '`') &&
                    content[candidate + tickCount] !== '`'
                ) {
                    closingIndex = candidate;
                    break;
                }
                searchFrom = candidate + 1;
            }

            if (closingIndex !== -1) {
                const rawSpan = content.slice(index, closingIndex + tickCount);
                result += rawSpan;
                isLineStart = rawSpan.endsWith('\n');
                index = closingIndex + tickCount;
                continue;
            }
        }

        if (isLineStart) {
            const blockHtml = matchBlockHtml(content, index);
            if (blockHtml) {
                result += createPlaceholder('block', blockHtml);
                index += blockHtml.length;
                // `isLineStart` is intentionally left as-is (mirrors Orca's
                // verified scanner): `index` now points at the line's trailing
                // `\n` (or EOF), and the next iteration's char-copy recomputes
                // `isLineStart` from that newline.
                continue;
            }
        }

        if (content[index] === '<' && !isEscaped(content, index)) {
            const inlineHtml = matchInlineHtml(content.slice(index));
            if (inlineHtml) {
                result += createPlaceholder('inline', inlineHtml);
                index += inlineHtml.length;
                continue;
            }
        }

        const nextChar = content[index];
        result += nextChar;
        isLineStart = nextChar === '\n';
        index += 1;
    }

    return result;
}
