import { describe, expect, it } from 'vitest';

import {
    containsRenderableEnrichedMarkdownMath,
    normalizeEnrichedMarkdownMathDelimiters,
} from './normalizeEnrichedMarkdownMathDelimiters';

describe('normalizeEnrichedMarkdownMathDelimiters', () => {
    it('maps TeX inline and standalone display delimiters onto the enriched renderer contract', () => {
        expect(normalizeEnrichedMarkdownMathDelimiters([
            'Inline \\(x_i\\).',
            'Spaced \\( E = mc^2 \\).',
            '',
            '\\[',
            'y = \\frac{1}{2}',
            '\\]',
            '',
            '  \\[z^2\\]',
        ].join('\n'))).toBe([
            'Inline $x_i$.',
            'Spaced $E = mc^2$.',
            '',
            '$$',
            'y = \\frac{1}{2}',
            '$$',
            '',
            '  $$z^2$$',
        ].join('\n'));
    });

    it('does not reinterpret code, links, escaped delimiters, or incomplete streaming input', () => {
        const markdown = [
            'Code: `\\(inline code\\)`.',
            '',
            '[link \\(label\\)](https://example.com/\\(path\\))',
            '',
            'Bare URL: https://example.com/\\(path\\)',
            '',
            'Escaped: \\\\(literal\\\\).',
            '',
            'Streaming: \\(pending',
            '',
            '\\[',
            'display still pending',
        ].join('\n');

        expect(normalizeEnrichedMarkdownMathDelimiters(markdown)).toBe(markdown);
    });

    it('does not reinterpret TeX-looking path segments in case-insensitive HTTP URLs', () => {
        const markdown = [
            'Upper HTTPS: HTTPS://example.com/\\(path\\)',
            'Mixed HTTP: Http://example.com/\\(other\\)',
            'Bare WWW: www.example.com/\\(asset\\)',
            'Upper WWW: WWW.example.com/\\(asset\\)',
        ].join('\n');

        expect(normalizeEnrichedMarkdownMathDelimiters(markdown)).toBe(markdown);
    });

    it('normalizes math in nested list content while preserving real indented code', () => {
        expect(normalizeEnrichedMarkdownMathDelimiters([
            '- outer',
            '    - inner \\(x\\)',
            '    continuation \\(y\\)',
            '      indented code \\(z\\)',
            '',
            'Outside.',
            '',
            '    top-level code \\(w\\)',
        ].join('\n'))).toBe([
            '- outer',
            '    - inner $x$',
            '    continuation $y$',
            '      indented code \\(z\\)',
            '',
            'Outside.',
            '',
            '    top-level code \\(w\\)',
        ].join('\n'));
    });

    it('normalizes standalone display math inside blockquotes and list items', () => {
        expect(normalizeEnrichedMarkdownMathDelimiters([
            '> \\[',
            '> x + y',
            '> \\]',
            '> \\[z^2\\]',
            '',
            '- \\[',
            '  a = b',
            '  \\]',
            '- \\[c^2\\]',
        ].join('\n'))).toBe([
            '> $$',
            '> x + y',
            '> $$',
            '> $$z^2$$',
            '',
            '- $$',
            '  a = b',
            '  $$',
            '- $$c^2$$',
        ].join('\n'));
    });

    it('preserves fenced and indented code inside blockquotes', () => {
        const markdown = [
            '> ```tex',
            '> \\(fenced code\\)',
            '> ```',
            '>',
            '>     \\(indented code\\)',
            '>',
            '> Prose \\(x\\).',
        ].join('\n');

        expect(normalizeEnrichedMarkdownMathDelimiters(markdown)).toBe([
            '> ```tex',
            '> \\(fenced code\\)',
            '> ```',
            '>',
            '>     \\(indented code\\)',
            '>',
            '> Prose $x$.',
        ].join('\n'));
    });

    it('preserves fenced and indented code owned by list items', () => {
        expect(normalizeEnrichedMarkdownMathDelimiters([
            '-     \\(indented code\\)',
            '- ```tex',
            '  \\(fenced code\\)',
            '  ```',
            '- Prose \\(x\\).',
        ].join('\n'))).toBe([
            '-     \\(indented code\\)',
            '- ```tex',
            '  \\(fenced code\\)',
            '  ```',
            '- Prose $x$.',
        ].join('\n'));
    });

    it('keeps non-standalone display delimiters and existing dollar math unchanged', () => {
        const markdown = [
            'Embedded \\[not a display block\\] text.',
            'Existing $x$ and $$y$$ plus currency $5.',
        ].join('\n');

        expect(normalizeEnrichedMarkdownMathDelimiters(markdown)).toBe(markdown);
    });

    it('continues normalizing after escaped Markdown punctuation', () => {
        expect(normalizeEnrichedMarkdownMathDelimiters([
            'Escaped tick: \\` literal; math \\(x\\).',
            'Escaped bracket: \\[literal then math \\(y\\).',
        ].join('\n'))).toBe([
            'Escaped tick: \\` literal; math $x$.',
            'Escaped bracket: \\[literal then math $y$.',
        ].join('\n'));
    });

    it('does not consume a later expression into an earlier unclosed inline delimiter', () => {
        expect(normalizeEnrichedMarkdownMathDelimiters(
            'Streaming: \\(pending; complete: \\(x\\).',
        )).toBe(
            'Streaming: \\(pending; complete: $x$.',
        );
    });

    it('does not consume a later display block into an earlier unclosed display delimiter', () => {
        expect(normalizeEnrichedMarkdownMathDelimiters([
            '\\[',
            'pending',
            '\\[',
            'x',
            '\\]',
        ].join('\n'))).toBe([
            '\\[',
            'pending',
            '$$',
            'x',
            '$$',
        ].join('\n'));
    });
});

describe('containsRenderableEnrichedMarkdownMath', () => {
    it.each([
        '\\(x\\)',
        '$x$',
        '$$x^2$$',
        'before $x$ after',
        '式：$x$。',
    ])('detects renderer-supported math in %s', (markdown) => {
        expect(containsRenderableEnrichedMarkdownMath(markdown)).toBe(true);
    });

    it.each([
        { name: 'plain text', markdown: 'plain text' },
        { name: 'currency', markdown: 'currency $5' },
        { name: 'currency range', markdown: 'range $5 - $10' },
        { name: 'escaped dollars', markdown: 'escaped \\$x\\$' },
        { name: 'inline code', markdown: '`$code$`' },
        { name: 'URL path', markdown: 'HTTPS://example.com/$path$' },
        { name: 'mismatched nested delimiters', markdown: '$a $$ b $' },
    ])('does not route non-math $name through the enriched table-cell renderer', ({ markdown }) => {
        expect(containsRenderableEnrichedMarkdownMath(markdown)).toBe(false);
    });
});
