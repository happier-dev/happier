import { describe, expect, it } from 'vitest';

import { reuseUnchangedMarkdownRenderSegments } from './reuseUnchangedMarkdownRenderSegments';
import { splitMarkdownRenderSegments } from './splitMarkdownRenderSegments';

describe('splitMarkdownRenderSegments', () => {
    it('reuses settled segments and refreshes a quote when its reference definition arrives', () => {
        const quote = ['> [Manual][manual]', '>', '> ~~~ts', '> const quoted = 1;', '> ~~~'].join('\n');
        const prefix = ['~~~ts', 'const value = 1;', '~~~', '', quote, '', 'Draft'].join('\n');
        const split = (markdown: string) => splitMarkdownRenderSegments({ markdown, streamingMode: 'streaming' });
        const first = split(prefix);
        const next = reuseUnchangedMarkdownRenderSegments(first, split(prefix + ' tail'));
        expect(next[0]?.type).toBe('special-block');
        expect(next[0]).toBe(first[0]);
        expect(next[1]?.type).toBe('container-block');
        expect(next[1]).toBe(first[1]);

        const definition = '[manual]: https://example.com/manual';
        const edited = prefix.replace('value = 1', 'value = 2') + ' tail\n\n' + definition;
        const updated = reuseUnchangedMarkdownRenderSegments(next, split(edited));
        expect(updated[0]).toMatchObject({ type: 'special-block', blocks: [{ type: 'code-block', content: 'const value = 2;' }] });
        expect(updated[1]).toMatchObject({
            type: 'container-block',
            container: { type: 'quote', children: [{ type: 'prose', markdown: definition + '\n\n[Manual][manual]' }, { type: 'code' }] },
        });
    });

    it.each(['static', 'streaming'] as const)('renders dedicated continuation option lines in %s mode without converting inline examples', (streamingMode) => {
        const segments = splitMarkdownRenderSegments({
            markdown: 'Choose next:\n<option>Continue</option>\n<option>Review first</option>\n</options>',
            streamingMode,
        });
        expect(segments.flatMap((segment) => segment.type === 'special-block' ? segment.blocks : [])).toContainEqual({
            type: 'options', items: ['Continue', 'Review first'],
        });
        const prose = splitMarkdownRenderSegments({
            markdown: 'Mention <option>Continue</option> in a sentence.',
            streamingMode,
        });
        expect(prose.map((segment) => segment.type)).toEqual(['enriched-markdown']);
    });

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

    it('keeps parsed closed fences while the streaming tail grows and refreshes edited fences', () => {
        const fence = ['~~~ts', 'const value = 1;', '~~~'].join('\n');
        const first = splitMarkdownRenderSegments({ markdown: fence + '\n\nDraft', streamingMode: 'streaming' });
        const next = splitMarkdownRenderSegments({
            markdown: fence + '\n\nDraft tail',
            streamingMode: 'streaming',
            previousSegments: first,
        });
        const edited = splitMarkdownRenderSegments({
            markdown: fence.replace('= 1', '= 2') + '\n\nDraft tail',
            streamingMode: 'streaming',
            previousSegments: next,
        });
        const [firstFence] = first;
        const [nextFence] = next;
        const [editedFence] = edited;
        if (firstFence?.type !== 'special-block' || nextFence?.type !== 'special-block' || editedFence?.type !== 'special-block') {
            throw new Error('Expected the leading segment to be a fenced block');
        }
        expect(nextFence.blocks).toBe(firstFence.blocks);
        expect(next[1]).toMatchObject({ type: 'enriched-markdown', markdown: 'Draft tail' });
        expect(editedFence.blocks).toMatchObject([{ type: 'code-block', content: 'const value = 2;' }]);
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
