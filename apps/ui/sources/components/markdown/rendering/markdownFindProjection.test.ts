import { describe, expect, it } from 'vitest';
import { projectMarkdownFindSpans, projectMarkdownFindText } from './markdownFindProjection';

describe('projectMarkdownFindText', () => {
    it('projects canonical Markdown text and maps repeated labels across hidden destinations and markup', () => {
        const markdown = '# **same** [same](https://hidden/same) 😀';
        const result = projectMarkdownFindText(markdown);
        expect(result.text).toBe('same same 😀');
        expect(result.sourceOffsets.slice(0, 4)).toEqual([4, 5, 6, 7]);
        expect(result.sourceOffsets.slice(5, 9)).toEqual([12, 13, 14, 15]);
        expect(result.sourceOffsets.slice(-2)).toEqual([39, 40]);
        expect(result.sourceEnds.slice(-2)).toEqual([40, 41]);
    });

    it('matches actual enriched escape and omitted-entity behavior, but preserves inline code literally', () => {
        const markdown = '\\* &amp; &#x1F600; `&amp; \\*`';
        const result = projectMarkdownFindText(markdown);
        expect(result.text).toBe('*   &amp; \\*');
        expect(result.sourceOffsets.slice(0, 4)).toEqual([1, 2, 8, 18]);
        expect(result.sourceEnds.slice(0, 4)).toEqual([2, 3, 9, 19]);
    });

    it('uses special block display text rather than fence syntax, language, or option tags', () => {
        const markdown = '```ts\nconst 😀 = 1;\n```\n\n<options>\n<option>choose **literally**</option>\n</options>';
        const result = projectMarkdownFindText(markdown);
        expect(result.text).toBe('const 😀 = 1;\nchoose **literally**');
        expect(result.sourceOffsets.slice(0, 5)).toEqual([6, 7, 8, 9, 10]);
        expect(result.sourceEnds).toHaveLength(result.text.length);
    });

    it('excludes diagram media and error-source fallback without making text coverage incomplete', () => {
        const result = projectMarkdownFindText('```mermaid\nflowchart LR\nA --> B\n```\n\nvisible needle');
        expect(result.text).toBe('visible needle');
        expect(result).not.toHaveProperty('incomplete');
        expect(projectMarkdownFindText('**visible needle**')).not.toHaveProperty('incomplete');
        expect(projectMarkdownFindText('```txt\nflowchart LR\nA --> B\n```')).not.toHaveProperty('incomplete');
    });

    it('maps code lines after the canonical fence parser removes indentation', () => {
        const source = '   ```txt\n   same\n    same\n   ```';
        const projected = projectMarkdownFindText(source);
        expect(projected.text).toBe('same\n same');
        expect(projected.sourceOffsets[0]).toBe(source.indexOf('same'));
        expect(projected.sourceOffsets[6]).toBe(source.lastIndexOf('same'));
    });

    it('ignores reference definitions and container markers while retaining link labels', () => {
        expect(projectMarkdownFindText('> [shown][ref]\n\n[ref]: https://secret').text).toBe('shown');
        expect(projectMarkdownFindText('- [x] **done**\n- next').text).toBe('done\nnext');
        expect(projectMarkdownFindText('> first\n> second').text).toBe('first\nsecond');
    });

    it('preserves nested display styles and original offsets after the render owner indents loose list continuations', () => {
        const spans = projectMarkdownFindSpans('**bold *nested***');
        expect(spans.find((span) => span.text === 'nested')).toMatchObject({ styles: ['bold', 'italic'] });
        expect(projectMarkdownFindSpans('~~settled~~').find((span) => span.text === 'settled')).toMatchObject({ styles: ['strikethrough'] });
        const source = '1. **Heading**\n\nBody sentence.\n\n2. **Next**';
        const projected = projectMarkdownFindText(source);
        const index = projected.text.indexOf('Body');
        expect(index).toBeGreaterThanOrEqual(0);
        expect(projected.sourceOffsets[index]).toBe(source.indexOf('Body'));
    });

    it('agrees with the real enriched md4c text leaves for nested, escaped, reference and entity fixtures', async () => {
        // Load the actual pinned web parser rather than the UI testkit native-view stub.
        const parserUrl = new URL('../../../../node_modules/react-native-enriched-markdown/lib/module/web/parseMarkdown.js', import.meta.url);
        const runtime: unknown = await import(/* @vite-ignore */ parserUrl.href);
        if (typeof runtime !== 'object' || runtime === null || !('parseMarkdown' in runtime) || typeof runtime.parseMarkdown !== 'function') {
            throw new Error('Pinned enriched parser unavailable');
        }
        const readText = (node: unknown): string => {
            if (typeof node !== 'object' || node === null) return '';
            const value = node as Record<string, unknown>;
            if (value.type === 'LineBreak') return '\n';
            const children = Array.isArray(value.children) ? value.children : [];
            return (typeof value.content === 'string' ? value.content : '') + children.map(readText).join('');
        };
        for (const source of ['**bold *nested***', '\\* &amp; &#x1F600; `&amp;`', '[shown][ref]\n\n[ref]: https://hidden', '<i>visible</i>', '# heading ###', 'heading\n====', ' visible 😀 ', 'a \nb', 'a  \nb', 'a\n  b']) {
            const ast: unknown = await runtime.parseMarkdown(source);
            expect(projectMarkdownFindText(source).text).toBe(readText(ast));
        }
    });
});
