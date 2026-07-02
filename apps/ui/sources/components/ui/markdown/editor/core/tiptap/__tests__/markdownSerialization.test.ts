import { describe, expect, it } from 'vitest';

import {
    docToMarkdown,
    markdownToDoc,
    roundTripMarkdown,
} from '../markdownSerialization';

/**
 * F4 / Lane F + Lane T idempotency contract (plan §5.3): for the Phase-1
 * formatting scope, serialize(parse(md)) must be STABLE — i.e. round-tripping the
 * already-round-tripped markdown is a no-op. This is what guarantees that opening
 * Rich and saving without edits never silently rewrites the user's file.
 *
 * We deliberately assert idempotency (a second round-trip equals the first)
 * rather than pinning exact serializer output: TipTap Markdown normalizes (e.g.
 * `*` vs `_`, list markers), and pinning the normalized form would be brittle.
 * Idempotency is the property the save-path early-return actually depends on.
 *
 * `MarkdownManager` (used by these helpers) is DOM-free, so this runs in the
 * default node environment.
 */

// A corpus covering the Phase-1 constructs (R-A9). Each entry is a construct the
// gate admits as eligible.
const PHASE_1_CORPUS: ReadonlyArray<readonly [label: string, markdown: string]> = [
    ['heading h1', '# Heading One'],
    ['heading h2', '## Heading Two'],
    ['heading h3', '### Heading Three'],
    ['bold', 'Some **bold** text.'],
    ['italic', 'Some *italic* text.'],
    ['strikethrough', 'Some ~~struck~~ text.'],
    ['inline code', 'Use `const x = 1` here.'],
    ['bullet list', '- one\n- two\n- three'],
    ['ordered list', '1. one\n2. two\n3. three'],
    ['task list', '- [ ] todo\n- [x] done'],
    ['blockquote', '> quoted line'],
    ['fenced code block', '```ts\nconst x: number = 1;\n```'],
    ['horizontal rule', 'above\n\n---\n\nbelow'],
    ['link', 'A [link](https://example.com) here.'],
    [
        'mixed document',
        '# Title\n\nIntro with **bold**, *italic*, and `code`.\n\n- bullet one\n- bullet two\n\n> a quote\n\n```js\nconsole.log(1);\n```',
    ],
];

describe('markdown serialization round-trip', () => {
    it.each(PHASE_1_CORPUS)('is idempotent for %s', (_label, markdown) => {
        const once = roundTripMarkdown(markdown);
        const twice = roundTripMarkdown(once);
        // The first round-trip may normalize; the SECOND must be a no-op.
        expect(twice).toBe(once);
    });

    it('parses markdown into a doc node', () => {
        const doc = markdownToDoc('# Hello\n\nWorld');
        expect(doc).toMatchObject({ type: 'doc' });
        expect(Array.isArray(doc.content)).toBe(true);
    });

    it('serializes a parsed doc back to a string', () => {
        const doc = markdownToDoc('# Hello');
        const out = docToMarkdown(doc);
        expect(typeof out).toBe('string');
        expect(out).toContain('Hello');
    });

    it('round-trips an empty document to a stable value', () => {
        const once = roundTripMarkdown('');
        const twice = roundTripMarkdown(once);
        expect(twice).toBe(once);
    });

    it('preserves the bold mark through a round-trip', () => {
        // The exact emphasis marker may normalize, but the word and SOME bold
        // marker must survive (not silently dropped).
        const out = roundTripMarkdown('Some **bold** word.');
        expect(out).toContain('bold');
        expect(out).toMatch(/\*\*bold\*\*|__bold__/);
    });

    it('preserves a link target through a round-trip', () => {
        const out = roundTripMarkdown('A [link](https://example.com) here.');
        expect(out).toContain('https://example.com');
    });

    it('roundTripMarkdown equals docToMarkdown(markdownToDoc(...))', () => {
        const md = '# Title\n\nbody **text**';
        expect(roundTripMarkdown(md)).toBe(docToMarkdown(markdownToDoc(md)));
    });
});
