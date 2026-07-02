import { describe, expect, it } from 'vitest';

import { stripMarkdownCode } from '../stripMarkdownCode';

describe('stripMarkdownCode', () => {
    it('leaves plain markdown without code untouched', () => {
        const md = '# Title\n\nSome **bold** text and a [link](https://x).';
        expect(stripMarkdownCode(md)).toBe(md);
    });

    it('blanks the content of fenced code blocks (backticks)', () => {
        const md = 'before\n```js\nconst x = "<div>";\n```\nafter';
        const stripped = stripMarkdownCode(md);

        expect(stripped).not.toContain('<div>');
        expect(stripped).not.toContain('const x');
        // Surrounding prose stays intact.
        expect(stripped).toContain('before');
        expect(stripped).toContain('after');
    });

    it('blanks the content of fenced code blocks (tildes)', () => {
        const md = '~~~\n[ref]: https://example.com\n~~~';
        const stripped = stripMarkdownCode(md);
        expect(stripped).not.toContain('https://example.com');
    });

    it('blanks inline code spans', () => {
        const md = 'Use `<br>` to break and `[^1]: foo` is just code.';
        const stripped = stripMarkdownCode(md);

        expect(stripped).not.toContain('<br>');
        expect(stripped).not.toContain('[^1]: foo');
        expect(stripped).toContain('Use');
        expect(stripped).toContain('to break');
    });

    it('preserves line count so line-anchored regexes keep their offsets', () => {
        const md = 'a\n```\nb\nc\n```\nd';
        const stripped = stripMarkdownCode(md);
        expect(stripped.split('\n').length).toBe(md.split('\n').length);
    });
});
