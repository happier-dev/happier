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
