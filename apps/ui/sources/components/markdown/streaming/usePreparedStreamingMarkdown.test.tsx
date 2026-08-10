import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';

import {
    STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
    STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS,
} from './streamingMarkdownRepairConfig';

const repairState = vi.hoisted(() => ({
    pending: [] as Array<{
        markdown: string;
        resolve: (value: string) => void;
    }>,
}));

vi.mock('./repairStreamingMarkdownAsync', () => ({
    repairStreamingMarkdownAsync: (markdown: string) =>
        new Promise<string>((resolve) => {
            repairState.pending.push({ markdown, resolve });
        }),
}));

function makeLargeMarkdown(suffix: string): string {
    return `${'x'.repeat(STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS)}${suffix}`;
}

describe('usePreparedStreamingMarkdown', () => {
    afterEach(() => {
        vi.useRealTimers();
        repairState.pending = [];
    });

    it('repairs small streaming markdown synchronously to preserve first-paint formatting', async () => {
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        const markdown = ['Formula:', '', '$$', 'E = mc^2'].join('\n');

        const hook = await renderHook(() => usePreparedStreamingMarkdown({
            markdown,
            mode: 'streaming',
        }));

        expect(hook.getCurrent()).toBe(['Formula:', '', '$$', 'E = mc^2', '$$'].join('\n'));
    });

    it('keeps static markdown unmodified', async () => {
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        const markdown = ['Formula:', '', '$$', 'E = mc^2'].join('\n');

        const hook = await renderHook(() => usePreparedStreamingMarkdown({
            markdown,
            mode: 'static',
        }));

        expect(hook.getCurrent()).toBe(markdown);
    });

    it('ignores async streaming repair results for markdown the stream did not continue from', async () => {
        vi.useFakeTimers();
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        const first = makeLargeMarkdown(' first **half');
        const second = makeLargeMarkdown(' second **half');

        const hook = await renderHook(
            ({ markdown }) => usePreparedStreamingMarkdown({
                markdown,
                mode: 'streaming',
            }),
            { initialProps: { markdown: first } },
        );

        expect(hook.getCurrent()).toBe(first);
        expect(repairState.pending).toEqual([]);

        await flushHookEffects({
            cycles: 1,
            turns: 1,
            advanceTimersMs: STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
        });
        expect(repairState.pending.map((request) => request.markdown)).toEqual([first]);

        await hook.rerender({ markdown: second });

        expect(hook.getCurrent()).toBe(second);

        repairState.pending[0]?.resolve('first repaired');
        await flushHookEffects();

        expect(hook.getCurrent()).toBe(second);

        await flushHookEffects({
            cycles: 1,
            turns: 1,
            advanceTimersMs: STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
        });
        expect(repairState.pending.map((request) => request.markdown)).toEqual([first, second]);

        repairState.pending[1]?.resolve('second repaired');
        await flushHookEffects();

        expect(hook.getCurrent()).toBe('second repaired');
    });

    it('keeps rendering repaired prose when a newer chunk has not been repaired yet', async () => {
        vi.useFakeTimers();
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        const body = `${'x'.repeat(STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS)}\n\n`;
        const openLink = `${body}See [the docs](https://exa`;
        const repairedOpenLink = `${body}See the docs`;
        const nextChunk = `${openLink}mple`;

        const hook = await renderHook(
            ({ markdown }) => usePreparedStreamingMarkdown({
                markdown,
                mode: 'streaming',
            }),
            { initialProps: { markdown: openLink } },
        );

        await flushHookEffects({
            cycles: 1,
            turns: 1,
            advanceTimersMs: STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
        });
        repairState.pending[0]?.resolve(repairedOpenLink);
        await flushHookEffects();

        expect(hook.getCurrent()).toBe(repairedOpenLink);

        await hook.rerender({ markdown: nextChunk });

        expect(hook.getCurrent()).not.toContain('](https://');
        expect(hook.getCurrent()).toContain('See the docs');
    });

    it('repairs large streaming markdown even while chunks keep arriving faster than the debounce', async () => {
        vi.useFakeTimers();
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        const body = 'x'.repeat(STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS);
        const appendedTokens = [' Here', ' is', ' **bo', 'ld', ' prose', ' that', ' keeps', ' going'];
        const chunkAt = (count: number) => `${body}${appendedTokens.slice(0, count).join('')}`;
        const lastChunk = chunkAt(appendedTokens.length);

        const hook = await renderHook(
            ({ markdown }) => usePreparedStreamingMarkdown({
                markdown,
                mode: 'streaming',
            }),
            { initialProps: { markdown: chunkAt(1) } },
        );

        let resolvedRequests = 0;
        for (let count = 2; count <= appendedTokens.length; count++) {
            await hook.rerender({ markdown: chunkAt(count) });
            await flushHookEffects({
                cycles: 1,
                turns: 1,
                advanceTimersMs: STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS - 8,
            });
            while (resolvedRequests < repairState.pending.length) {
                const request = repairState.pending[resolvedRequests];
                resolvedRequests++;
                request?.resolve(`${request.markdown}**`);
            }
            await flushHookEffects();
        }

        expect(resolvedRequests).toBeGreaterThan(0);
        expect(hook.getCurrent()).not.toBe(lastChunk);
        expect(hook.getCurrent().endsWith('**')).toBe(true);
    });

    it('does not fall back to raw markdown when streaming crosses the async repair threshold', async () => {
        vi.useFakeTimers();
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        const body = 'x'.repeat(STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS - 24);
        const belowThreshold = `${body} a **bo`;
        const aboveThreshold = `${body} a **bold and more text arrives`;

        const hook = await renderHook(
            ({ markdown }) => usePreparedStreamingMarkdown({
                markdown,
                mode: 'streaming',
            }),
            { initialProps: { markdown: belowThreshold } },
        );

        const belowPrepared = hook.getCurrent();
        expect(belowPrepared).toBe(`${belowThreshold}**`);

        await hook.rerender({ markdown: aboveThreshold });

        expect(hook.getCurrent()).not.toBe(aboveThreshold);
        expect(hook.getCurrent()).toBe(belowPrepared);
    });

    it('keeps the streamed tail when streaming resumes after a settle interlude', async () => {
        vi.useFakeTimers();
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        // A message that streamed past the async threshold, then settled into the static
        // render path (upstream paused), then resumed. The pre-threshold sync repair is an
        // ancestor of the current markdown but is thousands of characters behind it.
        const belowThreshold = 'x'.repeat(STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS - 32);
        const tail = ` TAIL-TOKEN ${'y'.repeat(240)}`;
        const aboveThreshold = `${belowThreshold}${tail}`;
        const repairedAboveThreshold = `${aboveThreshold}**`;

        const hook = await renderHook(
            ({ markdown, mode }) => usePreparedStreamingMarkdown({ markdown, mode }),
            { initialProps: { markdown: belowThreshold, mode: 'streaming' as 'streaming' | 'static' } },
        );

        expect(hook.getCurrent()).toBe(belowThreshold);

        await hook.rerender({ markdown: aboveThreshold, mode: 'streaming' });
        await flushHookEffects({
            cycles: 1,
            turns: 1,
            advanceTimersMs: STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
        });
        repairState.pending[0]?.resolve(repairedAboveThreshold);
        await flushHookEffects();

        expect(hook.getCurrent()).toBe(repairedAboveThreshold);

        // The stream settles: the caller swaps to the static render path.
        await hook.rerender({ markdown: aboveThreshold, mode: 'static' });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(aboveThreshold);

        // Upstream resumes with the same text. Nothing about the document changed, so the
        // rendered markdown must not lose text that is already on screen.
        await hook.rerender({ markdown: aboveThreshold, mode: 'streaming' });

        expect(hook.getCurrent()).toBe(repairedAboveThreshold);
    });

    it('keeps text the static interlude already painted when streaming resumes', async () => {
        vi.useFakeTimers();
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        // The repaired document lags the stream by one debounce plus one repair, by design.
        // When upstream pauses, the caller swaps to the static path, which paints the FULL
        // current text — including the tail that no repair has covered yet. The next chunk
        // swaps back to streaming, and the repaired ancestor must not un-paint that tail.
        const body = 'x'.repeat(STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS);
        const repairedBody = `${body}**`;
        const settledText = `${body} TAIL-TOKEN ${'y'.repeat(240)}`;

        const hook = await renderHook(
            ({ markdown, mode }) => usePreparedStreamingMarkdown({ markdown, mode }),
            { initialProps: { markdown: body, mode: 'streaming' as 'streaming' | 'static' } },
        );

        await flushHookEffects({
            cycles: 1,
            turns: 1,
            advanceTimersMs: STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
        });
        repairState.pending[0]?.resolve(repairedBody);
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(repairedBody);

        // The tail arrives; its repair has not landed when upstream goes quiet.
        await hook.rerender({ markdown: settledText, mode: 'streaming' });
        expect(hook.getCurrent()).toBe(repairedBody);

        // Settle: the static path paints the whole message, tail included.
        await hook.rerender({ markdown: settledText, mode: 'static' });
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(settledText);

        // Upstream resumes. The tail is already on screen and must stay there.
        await hook.rerender({ markdown: settledText, mode: 'streaming' });

        expect(hook.getCurrent()).toContain('TAIL-TOKEN');
        expect(hook.getCurrent()).toBe(settledText);
    });

    it('coalesces rapid large streaming markdown repairs to the latest payload', async () => {
        vi.useFakeTimers();
        const { usePreparedStreamingMarkdown } = await import('./usePreparedStreamingMarkdown');
        const first = makeLargeMarkdown(' first **half');
        const second = makeLargeMarkdown(' second **half');

        const hook = await renderHook(
            ({ markdown }) => usePreparedStreamingMarkdown({
                markdown,
                mode: 'streaming',
            }),
            { initialProps: { markdown: first } },
        );

        expect(hook.getCurrent()).toBe(first);
        expect(repairState.pending).toEqual([]);

        await hook.rerender({ markdown: second });

        expect(hook.getCurrent()).toBe(second);
        expect(repairState.pending).toEqual([]);

        await flushHookEffects({
            cycles: 1,
            turns: 1,
            advanceTimersMs: STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
        });

        expect(repairState.pending.map((request) => request.markdown)).toEqual([second]);
    });
});
