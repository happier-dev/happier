import { describe, expect, it } from 'vitest';

import { splitMarkdownRenderSegments } from './splitMarkdownRenderSegments';

describe('splitMarkdownRenderSegments source ranges', () => {
    it('assigns source line ranges to enriched and special markdown segments', () => {
        const segments = splitMarkdownRenderSegments({
            markdown: [
                '# Title',
                '',
                'Paragraph',
                '',
                '```ts',
                'const value = 1;',
                '```',
            ].join('\n'),
            streamingMode: 'static',
        });

        expect(segments.map((segment) => segment.sourceRange)).toEqual([
            { startLine: 1, endLine: 3 },
            { startLine: 5, endLine: 7 },
        ]);
    });
    it('keeps a multiline paragraph and setext heading intact when measuring source ranges', () => {
        const segments = splitMarkdownRenderSegments({
            markdown: 'Heading\n=======\n\nFirst line\nsecond line.',
            streamingMode: 'static',
            splitEnrichedSourceRanges: true,
        });
        expect(segments.map((segment) => segment.markdown)).toEqual(['Heading\n=======', 'First line\nsecond line.']);
    });

    it('preserves complete-list, paragraph, heading and reference-link semantics in the real enriched parser', async () => {
        const wasmPath = new URL('../../../../node_modules/react-native-enriched-markdown/src/web/wasm/md4c.js', import.meta.url).href;
        const { default: initialize } = await import(/* @vite-ignore */ wasmPath);
        const wasm = await initialize();
        const parse = wasm.cwrap('parseMarkdown', 'string', ['string', 'number', 'number']) as (text: string, underline: number, math: number) => string;
        const markdown = '[ref]: https://example.com "Title"\n\nHeading\n=======\n\nFirst line\nsecond line with [a reference][ref] and [quoted][quoted].\n\n- First item\n  continuation\n  - Nested item\n\n> [quoted]:\n>   https://example.org\n>   "Quoted"\n>\n> [ref]: https://other.example.com\n>\n> [Same reference][ref]';
        const segments = splitMarkdownRenderSegments({ markdown, streamingMode: 'static', splitEnrichedSourceRanges: true });
        const document = JSON.parse(parse(markdown, 0, 0));
        const renderedChildren = segments.flatMap((segment) => {
            expect(segment.type).toBe('enriched-markdown');
            if (segment.type !== 'enriched-markdown') return [];
            return JSON.parse(parse(segment.renderMarkdown ?? segment.markdown, 0, 0)).children;
        });
        expect(renderedChildren).toEqual(document.children);
    });
    it('retains top-level fences and tables while keeping a fenced list item in its complete list', () => {
        const markdown = '- Item\n\n  ```ts\n  const nested = 1;\n  ```\n\n```ts\nconst top = 2;\n```\n\n| Name | Value |\n| --- | --- |\n| one | two |';
        const segments = splitMarkdownRenderSegments({ markdown, streamingMode: 'static', splitEnrichedSourceRanges: true });
        expect(segments.map((segment) => segment.type)).toEqual(['container-block', 'special-block', 'special-block']);
        expect(segments[0]?.markdown).toContain('const nested = 1;');
        expect(segments[1]?.type === 'special-block' && segments[1].blocks[0]?.type).toBe('code-block');
        expect(segments[2]?.type === 'special-block' && segments[2].blocks[0]?.type).toBe('table');
    });

});
