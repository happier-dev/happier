import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import { useScmDiffExpandedKeys } from './useScmDiffExpandedKeys';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const largeReviewKeys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
const noViewableIndices: readonly number[] = [];
const scrolledViewableIndices: readonly number[] = [3];

describe('useScmDiffExpandedKeys', () => {
    it('applies initialCollapsedKeys and reports updates in list order', async () => {
        const onCollapsedKeysChange = vi.fn();
        const allKeys = ['a', 'b', 'c'] as const;
        const viewableIndices = [0] as const;

        const hook = await renderHook(() => useScmDiffExpandedKeys({
            allKeys,
            viewableIndices,
            tooLarge: false,
            aheadCount: 1,
            behindCount: 1,
            resetKey: 'k1',
            initialCollapsedKeys: ['b'],
            onCollapsedKeysChange,
        }));

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'c']);

        await act(async () => {
            hook.getCurrent().toggleCollapsed('a');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['c']);
        expect(onCollapsedKeysChange).toHaveBeenCalled();
        const last = onCollapsedKeysChange.mock.calls[onCollapsedKeysChange.mock.calls.length - 1]?.[0];
        expect(last).toEqual(['a', 'b']);
        await hook.unmount();
    });

    it('filters initialCollapsedKeys to known keys', async () => {
        const allKeys = ['a'] as const;
        const viewableIndices = [0] as const;
        const hook = await renderHook(() => useScmDiffExpandedKeys({
            allKeys,
            viewableIndices,
            tooLarge: false,
            aheadCount: 1,
            behindCount: 1,
            resetKey: 'k1',
            initialCollapsedKeys: ['a', 'missing'],
        }));

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual([]);
        await hook.unmount();
    });

    it('reconciles changed file keys and initial collapsed paths', async () => {
        const hook = await renderHook((props: { allKeys: readonly string[]; initialCollapsedKeys: readonly string[] }) => useScmDiffExpandedKeys({
            allKeys: props.allKeys,
            viewableIndices: noViewableIndices,
            tooLarge: false,
            aheadCount: 1,
            behindCount: 1,
            resetKey: 'same-snapshot',
            initialCollapsedKeys: props.initialCollapsedKeys,
        }), {
            initialProps: { allKeys: ['a', 'b'], initialCollapsedKeys: ['b'] },
        });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a']);

        await hook.rerender({ allKeys: ['a', 'c'], initialCollapsedKeys: ['a'] });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['c']);
        await hook.unmount();
    });

    it('keeps manual folds and expansions when the initial file window changes, and resets on a new scope', async () => {
        const initialProps: { allKeys: readonly string[]; resetKey: string } = {
            allKeys: largeReviewKeys, resetKey: 'one-review',
        };
        const hook = await renderHook((props: { allKeys: readonly string[]; resetKey: string }) => useScmDiffExpandedKeys({
            ...props, viewableIndices: noViewableIndices, tooLarge: true, aheadCount: 1, behindCount: 0,
        }), { initialProps });
        await act(async () => {
            hook.getCurrent().toggleCollapsed('a');
            hook.getCurrent().toggleCollapsed('g');
        });
        const allKeys = ['new', ...largeReviewKeys];
        await hook.rerender({ allKeys, resetKey: 'one-review' });
        expect(hook.getCurrent().expandedKeys.has('a')).toBe(false);
        expect(hook.getCurrent().expandedKeys.has('g')).toBe(true);
        await hook.rerender({ allKeys, resetKey: 'another-review' });
        expect(hook.getCurrent().expandedKeys.has('a')).toBe(true);
        expect(hook.getCurrent().expandedKeys.has('g')).toBe(false);
        await hook.unmount();
    });

    it('starts large reviews with the initial bounded prefetch window expanded', async () => {
        const hook = await renderHook(() => useScmDiffExpandedKeys({
            allKeys: largeReviewKeys,
            viewableIndices: noViewableIndices,
            tooLarge: true,
            aheadCount: 2,
            behindCount: 1,
            resetKey: 'k1',
            initialCollapsedKeys: [],
        }));

        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'b', 'c', 'd']);
        await hook.unmount();
    });

    it('tracks the bounded visible window in large reviews', async () => {
        const hook = await renderHook((props: { viewableIndices: readonly number[] }) => useScmDiffExpandedKeys({
            allKeys: largeReviewKeys,
            viewableIndices: props.viewableIndices,
            tooLarge: true,
            aheadCount: 1,
            behindCount: 1,
            resetKey: 'k1',
            initialCollapsedKeys: [],
        }), {
            initialProps: { viewableIndices: noViewableIndices },
        });

        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'b', 'c']);

        await hook.rerender({ viewableIndices: scrolledViewableIndices });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['c', 'd', 'e']);
        await hook.unmount();
    });

    it('never grows the files shown above a revealed file in a 55,919-file review, until it is first on screen or gone', async () => {
        const allKeys = Array.from({ length: 55_919 }, (_, index) => `file-${index}`);
        const range = (start: number, end: number) => Array.from({ length: end - start }, (_, offset) => start + offset);
        const expandedIndices = (keys: ReadonlySet<string>, indices: readonly number[]) => indices.filter((index) => keys.has(allKeys[index]!));
        type Props = { viewableIndices: readonly number[]; reveal: Readonly<{ key: string; index: number }> | null };
        const initialProps: Props = { viewableIndices: range(0, 10), reveal: null };
        const hook = await renderHook((props: Props) => useScmDiffExpandedKeys({
            allKeys, viewableIndices: props.viewableIndices, tooLarge: true, aheadCount: 14, behindCount: 8, resetKey: 'r', reveal: props.reveal,
        }), { initialProps });
        const show = async (props: Props) => { await hook.rerender(props); await flushHookEffects({ cycles: 2, turns: 2 }); };
        const last = allKeys.length - 1;

        // The list cannot bring the final file to the top: it lands at the bottom, under nine others.
        const finalReveal = { key: allKeys[last]!, index: last };
        await show({ viewableIndices: range(0, 10), reveal: finalReveal });
        await show({ viewableIndices: range(last - 9, last + 1), reveal: finalReveal });
        expect(hook.getCurrent().expandedKeys.has(allKeys[last]!)).toBe(true);
        expect(expandedIndices(hook.getCurrent().expandedKeys, range(last - 9, last))).toEqual([]);
        // Reading upward while it is still on screen grows nothing above it.
        await show({ viewableIndices: range(last - 12, last - 2 + 1).concat(last), reveal: finalReveal });
        expect(expandedIndices(hook.getCurrent().expandedKeys, range(last - 12, last))).toEqual([]);
        // Once it is gone, the ordinary window follows the screen again.
        await show({ viewableIndices: range(last - 20, last - 10), reveal: finalReveal });
        expect(expandedIndices(hook.getCurrent().expandedKeys, range(last - 20, last - 10))).toEqual(range(last - 20, last - 10));
        await show({ viewableIndices: range(last - 9, last + 1), reveal: finalReveal });
        expect(expandedIndices(hook.getCurrent().expandedKeys, range(last - 9, last + 1))).toEqual(range(last - 9, last + 1));

        // A file the list brings to the top keeps the ordinary window, including the files just above it.
        const middle = Math.floor(allKeys.length / 2);
        const middleReveal = { key: allKeys[middle]!, index: middle };
        await show({ viewableIndices: range(middle, middle + 10), reveal: middleReveal });
        expect(expandedIndices(hook.getCurrent().expandedKeys, range(middle - 8, middle + 24))).toEqual(range(middle - 8, middle + 24));
        // Scrolling up from it afterwards also stays ordinary.
        await show({ viewableIndices: range(middle - 3, middle + 7), reveal: middleReveal });
        expect(expandedIndices(hook.getCurrent().expandedKeys, range(middle - 3, middle))).toEqual(range(middle - 3, middle));
        await hook.unmount();
    });

    it('keeps manually expanded rows outside the automatic large-review window', async () => {
        const hook = await renderHook(() => useScmDiffExpandedKeys({
            allKeys: largeReviewKeys,
            viewableIndices: noViewableIndices,
            tooLarge: true,
            aheadCount: 1,
            behindCount: 0,
            resetKey: 'k1',
            initialCollapsedKeys: [],
            viewableExpansionEnabled: false,
        }));

        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'b']);

        await act(async () => {
            hook.getCurrent().toggleCollapsed('d');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'b', 'd']);

        await act(async () => {
            hook.getCurrent().toggleCollapsed('d');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'b']);
        await hook.unmount();
    });

    it('ignores viewability changes while large-review viewable expansion is disabled', async () => {
        const hook = await renderHook((props: { viewableIndices: readonly number[] }) => useScmDiffExpandedKeys({
            allKeys: largeReviewKeys,
            viewableIndices: props.viewableIndices,
            tooLarge: true,
            aheadCount: 3,
            behindCount: 2,
            resetKey: 'k1',
            initialCollapsedKeys: [],
            viewableExpansionEnabled: false,
        }), {
            initialProps: { viewableIndices: noViewableIndices },
        });

        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);

        await hook.rerender({ viewableIndices: scrolledViewableIndices });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        await hook.unmount();
    });
});
