import { describe, expect, it } from 'vitest';

import { splitMarkdownRenderSegments } from './splitMarkdownRenderSegments';

describe('splitMarkdownRenderSegments', () => {
    it('reuses segment arrays for unchanged markdown and rendering mode', () => {
        const markdown = [
            '## Long section',
            '',
            'This paragraph is stable across transcript remounts.',
            '',
            '- one',
            '- two',
        ].join('\n');

        const first = splitMarkdownRenderSegments({ markdown, streamingMode: 'static' });
        const next = splitMarkdownRenderSegments({ markdown, streamingMode: 'static' });

        expect(next).toBe(first);
    });

    it('does not retain very large static markdown as a cache entry', () => {
        const markdown = [
            '## Very large transcript message',
            '',
            'Large transcript prose '.repeat(2_000),
        ].join('\n');

        expect(markdown.length).toBeGreaterThan(32_000);

        const first = splitMarkdownRenderSegments({ markdown, streamingMode: 'static' });
        const next = splitMarkdownRenderSegments({ markdown, streamingMode: 'static' });

        expect(next).not.toBe(first);
        expect(next).toEqual(first);
    });

    it('bounds retained static markdown by content weight rather than entry count alone', () => {
        const markdownEntries = Array.from({ length: 9 }, (_, index) => (
            `entry-${index}\n${String(index).repeat(31_000)}`
        ));
        const first = splitMarkdownRenderSegments({
            markdown: markdownEntries[0]!,
            streamingMode: 'static',
        });

        for (const markdown of markdownEntries.slice(1)) {
            splitMarkdownRenderSegments({ markdown, streamingMode: 'static' });
        }

        const revisited = splitMarkdownRenderSegments({
            markdown: markdownEntries[0]!,
            streamingMode: 'static',
        });
        expect(revisited).not.toBe(first);
        expect(revisited).toEqual(first);
    });

    it('keeps enriched prose segment keys stable during append-only streaming updates', () => {
        const first = splitMarkdownRenderSegments({
            markdown: ['Stable block', 'Draft one'].join('\n'),
            streamingMode: 'streaming',
        });
        const next = splitMarkdownRenderSegments({
            markdown: ['Stable block', 'Draft one plus more'].join('\n'),
            streamingMode: 'streaming',
        });

        expect(first[0]?.type).toBe('enriched-markdown');
        expect(next[0]?.type).toBe('enriched-markdown');
        expect(next[0]?.key).toBe(first[0]?.key);
    });

    it('keeps special segment keys stable when prose grows before a code fence', () => {
        const first = splitMarkdownRenderSegments({
            markdown: ['Intro', '', '```ts', 'const value = 1;', '```'].join('\n'),
            streamingMode: 'streaming',
        });
        const next = splitMarkdownRenderSegments({
            markdown: ['Intro with more words', '', '```ts', 'const value = 1;', '```'].join('\n'),
            streamingMode: 'streaming',
        });

        const firstSpecial = first.find((segment) => segment.type === 'special-block');
        const nextSpecial = next.find((segment) => segment.type === 'special-block');

        expect(firstSpecial?.key).toBeTruthy();
        expect(nextSpecial?.key).toBe(firstSpecial?.key);
    });

    it('does not reuse a special segment key for a new block inserted before an existing special block', () => {
        const first = splitMarkdownRenderSegments({
            markdown: ['Intro', '', '```ts', 'const alpha = 1;', '```'].join('\n'),
            streamingMode: 'streaming',
        });
        const next = splitMarkdownRenderSegments({
            markdown: [
                '```sh',
                'echo beta',
                '```',
                '',
                'Intro',
                '',
                '```ts',
                'const alpha = 1;',
                '```',
            ].join('\n'),
            streamingMode: 'streaming',
        });

        const firstSpecial = first.find((segment) => segment.type === 'special-block');
        const nextSpecials = next.filter((segment) => segment.type === 'special-block');

        expect(firstSpecial?.key).toBeTruthy();
        expect(nextSpecials[0]?.key).not.toBe(firstSpecial?.key);
    });

    it('keeps code fence segment keys stable as streamed fence content grows and closes', () => {
        const first = splitMarkdownRenderSegments({
            markdown: ['```ts', 'const value = 1;'].join('\n'),
            streamingMode: 'streaming',
        });
        const next = splitMarkdownRenderSegments({
            markdown: ['```ts', 'const value = 1;', 'const next = 2;'].join('\n'),
            streamingMode: 'streaming',
        });
        const settled = splitMarkdownRenderSegments({
            markdown: ['```ts', 'const value = 1;', 'const next = 2;', '```'].join('\n'),
            streamingMode: 'streaming',
        });

        expect(first[0]?.type).toBe('special-block');
        expect(next[0]?.key).toBe(first[0]?.key);
        expect(settled[0]?.key).toBe(first[0]?.key);
    });

    it('keeps options segment keys stable as streamed options content grows and closes', () => {
        const first = splitMarkdownRenderSegments({
            markdown: ['<options>', '<option>Run'].join('\n'),
            streamingMode: 'streaming',
        });
        const next = splitMarkdownRenderSegments({
            markdown: ['<options>', '<option>Run command</option>'].join('\n'),
            streamingMode: 'streaming',
        });
        const settled = splitMarkdownRenderSegments({
            markdown: ['<options>', '<option>Run command</option>', '</options>'].join('\n'),
            streamingMode: 'streaming',
        });

        expect(first[0]?.type).toBe('special-block');
        expect(next[0]?.key).toBe(first[0]?.key);
        expect(settled[0]?.key).toBe(first[0]?.key);
    });

    it('keeps table segment keys stable as streamed table rows append', () => {
        const first = splitMarkdownRenderSegments({
            markdown: ['| Name | Value |', '| --- | --- |', '| Alpha | 1 |'].join('\n'),
            streamingMode: 'streaming',
        });
        const next = splitMarkdownRenderSegments({
            markdown: ['| Name | Value |', '| --- | --- |', '| Alpha | 1 |', '| Beta | 2 |'].join('\n'),
            streamingMode: 'streaming',
        });

        expect(first[0]?.type).toBe('special-block');
        expect(next[0]?.key).toBe(first[0]?.key);
    });
});
