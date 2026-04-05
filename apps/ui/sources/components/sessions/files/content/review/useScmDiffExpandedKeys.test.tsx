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
});
