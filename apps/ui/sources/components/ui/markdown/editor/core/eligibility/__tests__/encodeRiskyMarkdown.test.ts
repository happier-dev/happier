import { describe, expect, it } from 'vitest';

import {
    RAW_HTML_BLOCK_PLACEHOLDER_PREFIX,
    RAW_HTML_INLINE_PLACEHOLDER_PREFIX,
    encodeRiskyMarkdown,
    matchPlaceholder,
} from '../encodeRiskyMarkdown';

/**
 * Phase-1.5 risky-markdown pre-pass (pure encoder). These assert the scanner's
 * SAFETY boundaries — what must NOT be encoded (code regions, escaped `<`) and
 * what MUST be encoded (block-only HTML, inline HTML, comments) — plus the
 * load-bearing URI-encode round-trip (a payload containing `]]` must survive).
 *
 * The encoder is pure regex/string work, so this runs in the default node env.
 */

describe('encodeRiskyMarkdown', () => {
    it('does NOT encode HTML inside a fenced code block', () => {
        const md = '```html\n<div class="x"><br></div>\n```';
        const out = encodeRiskyMarkdown(md);
        // The fenced content is copied verbatim — no sentinel is introduced.
        expect(out).toBe(md);
        expect(out).not.toContain(RAW_HTML_BLOCK_PLACEHOLDER_PREFIX);
        expect(out).not.toContain(RAW_HTML_INLINE_PLACEHOLDER_PREFIX);
    });

    it('does NOT encode HTML inside an inline code span', () => {
        const md = 'Use `<span>` inline here.';
        const out = encodeRiskyMarkdown(md);
        expect(out).toBe(md);
        expect(out).not.toContain(RAW_HTML_INLINE_PLACEHOLDER_PREFIX);
    });

    it('does NOT encode a backslash-escaped `\\<div>`', () => {
        const md = 'Literal \\<div> stays literal.';
        const out = encodeRiskyMarkdown(md);
        // The `<` is escaped (odd backslash parity), so it is not live HTML.
        expect(out).toBe(md);
        expect(out).not.toContain(RAW_HTML_INLINE_PLACEHOLDER_PREFIX);
    });

    it('encodes a block-only HTML line (single tag) into a block sentinel', () => {
        // A line that is ENTIRELY one tag is block-only HTML. (A line like
        // `<div>x</div>` with text/closing tag is handled by the inline path.)
        const md = '<div class="note">';
        const out = encodeRiskyMarkdown(md);
        expect(out.startsWith(RAW_HTML_BLOCK_PLACEHOLDER_PREFIX)).toBe(true);
        // The decoded payload is the original line, byte-for-byte.
        const matched = matchPlaceholder(out, 'block');
        expect(matched?.value).toBe(md);
    });

    it('encodes an open+text+close run on a line via the inline path', () => {
        // `<div ...>hello</div>` is NOT a single-tag line, so it is encoded as
        // inline sentinels (open tag + close tag), not a block sentinel.
        const md = '<div class="note">hello</div>';
        const out = encodeRiskyMarkdown(md);
        expect(out).toContain(RAW_HTML_INLINE_PLACEHOLDER_PREFIX);
        expect(out).not.toContain(RAW_HTML_BLOCK_PLACEHOLDER_PREFIX);
        const matched = matchPlaceholder(out, 'inline');
        expect(matched?.value).toBe('<div class="note">');
    });

    it('encodes inline HTML mid-paragraph into an inline sentinel', () => {
        const md = 'before <span>x</span> after';
        const out = encodeRiskyMarkdown(md);
        expect(out).toContain(RAW_HTML_INLINE_PLACEHOLDER_PREFIX);
        // The surrounding prose is preserved around the sentinel(s).
        expect(out.startsWith('before ')).toBe(true);
        expect(out.endsWith(' after')).toBe(true);
        // The first inline run decodes back to the opening tag.
        const firstSentinelStart = out.indexOf(RAW_HTML_INLINE_PLACEHOLDER_PREFIX);
        const matched = matchPlaceholder(out.slice(firstSentinelStart), 'inline');
        expect(matched?.value).toBe('<span>');
    });

    it('encodes an HTML comment', () => {
        const md = '<!-- a comment -->';
        const out = encodeRiskyMarkdown(md);
        // A comment alone on its line is block-only HTML.
        expect(out.startsWith(RAW_HTML_BLOCK_PLACEHOLDER_PREFIX)).toBe(true);
        const matched = matchPlaceholder(out, 'block');
        expect(matched?.value).toBe(md);
    });

    it('encodes an inline HTML comment mid-paragraph', () => {
        const md = 'text <!-- note --> more';
        const out = encodeRiskyMarkdown(md);
        expect(out).toContain(RAW_HTML_INLINE_PLACEHOLDER_PREFIX);
        const start = out.indexOf(RAW_HTML_INLINE_PLACEHOLDER_PREFIX);
        const matched = matchPlaceholder(out.slice(start), 'inline');
        expect(matched?.value).toBe('<!-- note -->');
    });

    it('preserves a payload that itself contains `]]` (URI-encode is load-bearing)', () => {
        // `]]` inside the raw HTML must NOT close the sentinel early — the payload
        // is URI-encoded, so the literal `]]` is escaped and survives decode. A
        // single self-closing tag is block-only HTML, so this is one block sentinel.
        const md = '<span data-x="a]]b" />';
        const out = encodeRiskyMarkdown(md);
        const matched = matchPlaceholder(out, 'block');
        expect(matched).not.toBeNull();
        // The decoded value is the EXACT original bytes, `]]` included.
        expect(matched?.value).toBe(md);
        // And the encoded payload does not contain a bare `]]` before the suffix.
        const payload = out.slice(
            RAW_HTML_BLOCK_PLACEHOLDER_PREFIX.length,
            out.length - ']]'.length,
        );
        expect(payload.includes(']]')).toBe(false);
    });

    it('preserves a `]]` payload through a full inline encode→decode', () => {
        // The same load-bearing guarantee for the inline path (open+text+close).
        const md = '<span data-x="a]]b">v</span>';
        const out = encodeRiskyMarkdown(md);
        const matched = matchPlaceholder(out, 'inline');
        expect(matched).not.toBeNull();
        // The first inline sentinel decodes to the opening tag, `]]` intact.
        expect(matched?.value).toBe('<span data-x="a]]b">');
    });

    it('is idempotent: an already-encoded document is copied verbatim', () => {
        const once = encodeRiskyMarkdown('before <span>x</span> after\n\n<div>block</div>');
        const twice = encodeRiskyMarkdown(once);
        expect(twice).toBe(once);
    });

    it('leaves plain markdown untouched', () => {
        const md = '# Title\n\nSome **bold** and a [link](https://example.com).';
        expect(encodeRiskyMarkdown(md)).toBe(md);
    });
});

describe('matchPlaceholder', () => {
    it('returns null when the prefix does not match', () => {
        expect(matchPlaceholder('plain text', 'inline')).toBeNull();
        expect(matchPlaceholder('plain text', 'block')).toBeNull();
    });

    it('returns null for a prefix with no terminating suffix', () => {
        expect(matchPlaceholder(`${RAW_HTML_INLINE_PLACEHOLDER_PREFIX}abc`, 'inline')).toBeNull();
    });
});
