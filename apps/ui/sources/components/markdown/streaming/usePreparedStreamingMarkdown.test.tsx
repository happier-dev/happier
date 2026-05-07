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

    it('ignores stale async streaming repair results after newer markdown arrives', async () => {
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

        await flushHookEffects({
            cycles: 1,
            turns: 1,
            advanceTimersMs: STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
        });
        expect(repairState.pending.map((request) => request.markdown)).toEqual([first, second]);

        repairState.pending[1]?.resolve('second repaired');
        await flushHookEffects();

        expect(hook.getCurrent()).toBe('second repaired');

        repairState.pending[0]?.resolve('first repaired');
        await flushHookEffects();

        expect(hook.getCurrent()).toBe('second repaired');
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
