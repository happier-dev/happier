import { describe, expect, it } from 'vitest';

import {
    docToMarkdown,
    markdownToDoc,
    roundTripMarkdown,
} from '../markdownSerialization';

/**
 * Phase-1.5 raw-HTML round-trip: with the `encodeRiskyMarkdown` pre-pass wired
 * into `markdownToDoc` and the byte-verbatim atom nodes registered, embedded raw
 * HTML / HTML comments must round-trip LOSSLESSLY (the original fragment appears
 * unchanged in the serialized output) and the round-trip must be IDEMPOTENT
 * (`roundTrip(roundTrip(x)) === roundTrip(x)`) — the property the save-path early
 * return and the eligibility gate depend on.
 *
 * `MarkdownManager` is DOM-free, so this runs in the default node environment.
 */

// Each entry is a markdown document containing a "risky" construct plus the raw
// HTML fragment we assert survives verbatim in the serialized output.
const RAW_HTML_CORPUS: ReadonlyArray<
    readonly [label: string, markdown: string, fragment: string]
> = [
    // Inline runs (open+text+close on one line, or embedded mid-paragraph) go
    // through the INLINE path: each tag becomes an inline atom, text stays text.
    ['inline html in a paragraph', 'before <span>x</span> after', '<span>x</span>'],
    ['self-closing widget', 'a <Widget /> b', '<Widget />'],
    ['open+text+close on a line', 'Intro\n\n<div class="note">hello</div>\n\nEnd', '<div class="note">hello</div>'],
    ['inline html comment', 'text <!-- inline note --> more', '<!-- inline note -->'],
    ['attribute containing brackets', '<span data-x="a]]b">v</span>', '<span data-x="a]]b">v</span>'],
    // Single-tag-on-a-line and a lone comment-line go through the BLOCK path.
    ['single block tag on its own line', 'Intro\n\n<hr class="rule">\n\nEnd', '<hr class="rule">'],
    ['block html comment', 'Intro\n\n<!-- a note -->\n\nEnd', '<!-- a note -->'],
    // An HTML <table>: the `<table>`/`</table>` tags are each block-only lines
    // (block atoms); the mixed `<tr><td>a</td>…` line goes through the inline
    // path. Either way every tag survives verbatim through a raw-HTML atom.
    [
        'html table tags',
        'Before\n\n<table>\n<tr><td>a</td><td>b</td></tr>\n</table>\n\nAfter',
        '<table>',
    ],
];

describe('raw-HTML markdown round-trip (Phase-1.5)', () => {
    it.each(RAW_HTML_CORPUS)('preserves %s verbatim', (_label, markdown, fragment) => {
        const out = roundTripMarkdown(markdown);
        expect(out).toContain(fragment);
    });

    it.each(RAW_HTML_CORPUS)('round-trips %s idempotently', (_label, markdown) => {
        const once = roundTripMarkdown(markdown);
        const twice = roundTripMarkdown(once);
        expect(twice).toBe(once);
    });

    it('round-trips a block-HTML-only document (not treated as empty)', () => {
        // A single tag on its own line is genuine block-only HTML -> a block atom.
        const md = '<div class="card">';
        const out = roundTripMarkdown(md);
        // The block-HTML atom must survive: the serialized output is non-empty and
        // contains the original fragment (the empty-doc edge case in the manager's
        // `isEmptyOutput` must not swallow it).
        expect(out.trim().length).toBeGreaterThan(0);
        expect(out).toContain('<div class="card">');
    });

    it('parses a single block tag into a raw-markdown-html-block atom node', () => {
        const doc = markdownToDoc('<hr class="rule">');
        const json = JSON.stringify(doc);
        expect(json).toContain('rawMarkdownHtmlBlock');
        // The decoded original bytes live on the node's `value` attr.
        expect(json).toContain('<hr class=\\"rule\\">');
    });

    it('parses inline HTML into a raw-markdown-html-inline atom node', () => {
        const doc = markdownToDoc('before <span>x</span> after');
        const json = JSON.stringify(doc);
        expect(json).toContain('rawMarkdownHtmlInline');
    });

    it('serializes a raw-HTML atom back to its verbatim bytes (no double-encode)', () => {
        const md = '<div class="note">hello</div>';
        const doc = markdownToDoc(md);
        const out = docToMarkdown(doc);
        // docToMarkdown must NOT re-encode: the output is the original markdown,
        // never a `[[HAPPIER_…]]` sentinel.
        expect(out).toContain('<div class="note">hello</div>');
        expect(out).not.toContain('[[HAPPIER_');
    });

    it('still does not preserve HTML written inside a code fence (stays literal code)', () => {
        // HTML inside a fence is NOT risky-encoded, so it round-trips as a code
        // block (the fence content is preserved), not as a raw-HTML atom.
        const md = '```html\n<div>x</div>\n```';
        const out = roundTripMarkdown(md);
        expect(out).toContain('<div>x</div>');
        expect(out).not.toContain('[[HAPPIER_');
    });
});
