import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useScmDiffExpandedKeys } from './useScmDiffExpandedKeys';
import { flushHookEffects, renderHook } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

    it('keeps collapsed state stable across rerenders with equivalent key arrays', async () => {
        const hook = await renderHook((props: {
            allKeys: readonly string[];
            viewableIndices: readonly number[];
            initialCollapsedKeys: readonly string[];
        }) => useScmDiffExpandedKeys({
            allKeys: props.allKeys,
            viewableIndices: props.viewableIndices,
            tooLarge: false,
            aheadCount: 1,
            behindCount: 1,
            resetKey: 'k1',
            initialCollapsedKeys: props.initialCollapsedKeys,
        }), {
            initialProps: {
                allKeys: ['a', 'b', 'c'],
                viewableIndices: [0],
                initialCollapsedKeys: ['b'],
            },
        });

        const firstCollapsedKeys = hook.getCurrent().collapsedKeys;

        await hook.rerender({
            allKeys: ['a', 'b', 'c'],
            viewableIndices: [0],
            initialCollapsedKeys: ['b'],
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(hook.getCurrent().collapsedKeys).toBe(firstCollapsedKeys);
        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'c']);
        await hook.unmount();
    });

    it('starts large reviews with one expanded anchor instead of the full prefetch window', async () => {
        const hook = await renderHook(() => useScmDiffExpandedKeys({
            allKeys: ['a', 'b', 'c', 'd', 'e'],
            viewableIndices: [],
            tooLarge: true,
            aheadCount: 3,
            behindCount: 2,
            resetKey: 'k1',
            initialCollapsedKeys: [],
        }));

        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a']);
        await hook.unmount();
    });

    it('tracks only the first visible anchor in large reviews', async () => {
        const hook = await renderHook((props: { viewableIndices: readonly number[] }) => useScmDiffExpandedKeys({
            allKeys: ['a', 'b', 'c', 'd', 'e'],
            viewableIndices: props.viewableIndices,
            tooLarge: true,
            aheadCount: 3,
            behindCount: 2,
            resetKey: 'k1',
            initialCollapsedKeys: [],
        }), {
            initialProps: { viewableIndices: [] as number[] },
        });

        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a']);

        await hook.rerender({ viewableIndices: [2, 3, 4] });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['c']);
        await hook.unmount();
    });

    it('lets users manually expand a non-anchor row in large reviews', async () => {
        const hook = await renderHook(() => useScmDiffExpandedKeys({
            allKeys: ['a', 'b', 'c', 'd', 'e'],
            viewableIndices: [],
            tooLarge: true,
            aheadCount: 3,
            behindCount: 2,
            resetKey: 'k1',
            initialCollapsedKeys: [],
            viewableExpansionEnabled: false,
        }));

        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a']);

        await act(async () => {
            hook.getCurrent().toggleCollapsed('c');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a', 'c']);

        await act(async () => {
            hook.getCurrent().toggleCollapsed('c');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a']);
        await hook.unmount();
    });

    it('ignores viewability changes while large-review viewable expansion is disabled', async () => {
        const hook = await renderHook((props: { viewableIndices: readonly number[] }) => useScmDiffExpandedKeys({
            allKeys: ['a', 'b', 'c', 'd', 'e'],
            viewableIndices: props.viewableIndices,
            tooLarge: true,
            aheadCount: 3,
            behindCount: 2,
            resetKey: 'k1',
            initialCollapsedKeys: [],
            viewableExpansionEnabled: false,
        }), {
            initialProps: { viewableIndices: [] as number[] },
        });

        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a']);

        await hook.rerender({ viewableIndices: [2, 3, 4] });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['a']);
        await hook.unmount();
    });
});
