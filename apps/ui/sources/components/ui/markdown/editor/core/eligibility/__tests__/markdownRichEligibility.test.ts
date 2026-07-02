import { describe, expect, it, vi } from 'vitest';

import {
    evaluateMarkdownRichEligibility,
    preservesEmbeddedHtml,
    type EvaluateMarkdownRichEligibilityOptions,
} from '../markdownRichEligibility';

const BASE_OPTS: EvaluateMarkdownRichEligibilityOptions = {
    language: 'markdown',
    maxBytes: 256_000,
    htmlRoundTripMaxBytes: 50_000,
};

// Each test uses a unique document (via docCounter) so the bounded content-hash
// cache never returns a stale verdict from another case.
let docCounter = 0;

describe('evaluateMarkdownRichEligibility', () => {
    it('admits plain eligible markdown', () => {
        const raw = `# Hello ${docCounter++}\n\nSome **bold** text and a list:\n- a\n- b`;
        expect(evaluateMarkdownRichEligibility(raw, BASE_OPTS)).toEqual({ eligible: true });
    });

    it('blocks non-markdown languages as mdx', () => {
        const raw = `# Doc ${docCounter++}`;
        expect(evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, language: 'mdx' })).toEqual({
            eligible: false,
            reason: 'mdx',
        });
    });

    it('blocks a null language as mdx', () => {
        const raw = `# Doc ${docCounter++}`;
        expect(evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, language: null })).toEqual({
            eligible: false,
            reason: 'mdx',
        });
    });

    it('blocks oversize bodies measured in UTF-8 bytes', () => {
        const raw = `${'a'.repeat(20)} ${docCounter++}`;
        expect(evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, maxBytes: 10 })).toEqual({
            eligible: false,
            reason: 'too-large',
        });
    });

    it('strips frontmatter before applying the size gate', () => {
        // The frontmatter alone exceeds maxBytes; the body fits, so it stays eligible.
        const frontmatter = `---\nfiller: ${'x'.repeat(50)}\nn: ${docCounter++}\n---\n`;
        const raw = `${frontmatter}# Title\n\nshort body`;
        expect(evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, maxBytes: 40 })).toEqual({
            eligible: true,
        });
    });

    it('blocks reference-link definitions', () => {
        const raw = `# Doc ${docCounter++}\n\nSee [the site][ref].\n\n[ref]: https://example.com`;
        expect(evaluateMarkdownRichEligibility(raw, BASE_OPTS)).toEqual({
            eligible: false,
            reason: 'reference-links',
        });
    });

    it('blocks footnote definitions', () => {
        const raw = `# Doc ${docCounter++}\n\nText with a note.[^1]\n\n[^1]: The note.`;
        expect(evaluateMarkdownRichEligibility(raw, BASE_OPTS)).toEqual({
            eligible: false,
            reason: 'footnotes',
        });
    });

    it('ignores HTML that only appears inside code', () => {
        const raw = `# Doc ${docCounter++}\n\nExample:\n\n\`\`\`html\n<div class="x"><br></div>\n\`\`\`\n\nand inline \`<span>\`.`;
        // No adapter needed — the probe has no HTML once code is stripped.
        expect(evaluateMarkdownRichEligibility(raw, BASE_OPTS)).toEqual({ eligible: true });
    });

    it('ignores reference-link syntax that only appears inside code', () => {
        const raw = `# Doc ${docCounter++}\n\n\`\`\`\n[ref]: https://example.com\n\`\`\``;
        expect(evaluateMarkdownRichEligibility(raw, BASE_OPTS)).toEqual({ eligible: true });
    });

    it('admits HTML outside code when the web round-trip preserves it', () => {
        const raw = `# Doc ${docCounter++}\n\n<div class="note">hello</div>`;
        const htmlRoundTrip = vi.fn((body: string) => body); // perfectly preserving
        expect(evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, htmlRoundTrip })).toEqual({
            eligible: true,
        });
        expect(htmlRoundTrip).toHaveBeenCalledTimes(1);
    });

    it('blocks HTML outside code when the web round-trip drops it', () => {
        const raw = `# Doc ${docCounter++}\n\n<div class="note">hello</div>`;
        const htmlRoundTrip = vi.fn(() => '# Doc\n\nhello'); // HTML fragment gone
        expect(evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, htmlRoundTrip })).toEqual({
            eligible: false,
            reason: 'html-or-jsx',
        });
    });

    it('blocks HTML outside code when the web round-trip fails (returns null)', () => {
        const raw = `# Doc ${docCounter++}\n\n<section>hi</section>`;
        const htmlRoundTrip = vi.fn(() => null);
        expect(evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, htmlRoundTrip })).toEqual({
            eligible: false,
            reason: 'html-or-jsx',
        });
    });

    it('blocks HTML on native (no adapter injected)', () => {
        const raw = `# Doc ${docCounter++}\n\n<div>native blocks this</div>`;
        expect(evaluateMarkdownRichEligibility(raw, BASE_OPTS)).toEqual({
            eligible: false,
            reason: 'html-or-jsx',
        });
    });

    it('blocks HTML on web when the body exceeds the round-trip budget (skips the round-trip)', () => {
        const big = `<div>${'x'.repeat(200)}</div>`;
        const raw = `# Doc ${docCounter++}\n\n${big}`;
        const htmlRoundTrip = vi.fn(() => raw);
        expect(
            evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, htmlRoundTripMaxBytes: 10, htmlRoundTrip }),
        ).toEqual({ eligible: false, reason: 'html-or-jsx' });
        // Round-trip is the expensive step — it must be skipped when over budget.
        expect(htmlRoundTrip).not.toHaveBeenCalled();
    });

    it('blocks HTML comments outside code', () => {
        const raw = `# Doc ${docCounter++}\n\n<!-- a comment -->`;
        expect(evaluateMarkdownRichEligibility(raw, BASE_OPTS)).toEqual({
            eligible: false,
            reason: 'html-or-jsx',
        });
    });

    it('caches the result by content hash (adapter only runs once for repeated input)', () => {
        const raw = `# Cached ${docCounter++}\n\n<div>x</div>`;
        const htmlRoundTrip = vi.fn((body: string) => body);
        const first = evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, htmlRoundTrip });
        const second = evaluateMarkdownRichEligibility(raw, { ...BASE_OPTS, htmlRoundTrip });

        expect(first).toEqual({ eligible: true });
        expect(second).toBe(first); // same cached object reference
        expect(htmlRoundTrip).toHaveBeenCalledTimes(1);
    });
});

describe('preservesEmbeddedHtml', () => {
    it('returns false for a null round-trip', () => {
        expect(preservesEmbeddedHtml('<div>x</div>', null)).toBe(false);
    });

    it('returns true when there are no HTML fragments to preserve', () => {
        expect(preservesEmbeddedHtml('plain text', 'plain text')).toBe(true);
    });

    it('requires each fragment to appear in order', () => {
        const probe = '<a></a> middle <b></b>';
        expect(preservesEmbeddedHtml(probe, 'x <a></a> y <b></b> z')).toBe(true);
        // Reordered output fails the ordered-substring check.
        expect(preservesEmbeddedHtml(probe, 'x <b></b> y <a></a> z')).toBe(false);
    });

    it('returns false when a fragment is dropped', () => {
        expect(preservesEmbeddedHtml('<img src="a"/>', 'no html here')).toBe(false);
    });
});
