import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useScmDiffExpandedKeys } from './useScmDiffExpandedKeys';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookValue = ReturnType<typeof useScmDiffExpandedKeys>;

async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function renderHook(useValue: () => HookValue): Promise<{ getCurrent: () => HookValue; rerender: () => void; unmount: () => void }> {
    let current: HookValue | null = null;
    function Test() {
        current = useValue();
        return null;
    }
    let root: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        root = renderer.create(React.createElement(Test));
        await flushAsync();
    });
    return {
        getCurrent: () => {
            if (!current) throw new Error('Hook did not render');
            return current;
        },
        rerender: () => {
            if (!root) return;
            act(() => {
                root!.update(React.createElement(Test));
            });
        },
        unmount: () => {
            if (!root) return;
            act(() => {
                root?.unmount();
            });
        },
    };
}

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
            await flushAsync();
        });

        expect(Array.from(hook.getCurrent().expandedKeys)).toEqual(['c']);
        expect(onCollapsedKeysChange).toHaveBeenCalled();
        const last = onCollapsedKeysChange.mock.calls[onCollapsedKeysChange.mock.calls.length - 1]?.[0];
        expect(last).toEqual(['a', 'b']);
        hook.unmount();
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
        hook.unmount();
    });
});
