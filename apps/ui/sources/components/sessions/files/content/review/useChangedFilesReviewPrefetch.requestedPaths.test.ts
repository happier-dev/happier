import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/state/storage', () => ({
    // Return non-numeric values so prefetch is disabled, but viewability/requestedPaths should still work.
    useSetting: () => null,
}));

function file(fullPath: string) {
    return { fullPath } as any;
}

async function flushAsync(count = 3): Promise<void> {
    for (let i = 0; i < count; i++) {
        await Promise.resolve();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type HookValue = ReturnType<typeof import('./useChangedFilesReviewPrefetch')['useChangedFilesReviewPrefetch']>;

async function renderHook(useValue: () => HookValue): Promise<{ getCurrent: () => HookValue; unmount: () => void }> {
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
        unmount: () => {
            if (!root) return;
            act(() => root?.unmount());
        },
    };
}

afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});

describe('useChangedFilesReviewPrefetch (requestedPaths)', () => {
    it('returns initialRequestedPaths before viewability updates', async () => {
        const { useChangedFilesReviewPrefetch } = await import('./useChangedFilesReviewPrefetch');

        const hook = await renderHook(() => useChangedFilesReviewPrefetch({
            sessionId: 's1',
            snapshotSignature: null,
            diffArea: 'pending' as any,
            rows: [{ kind: 'file', file: file('a.ts') }, { kind: 'file', file: file('b.ts') }] as any,
            reviewFiles: [file('a.ts'), file('b.ts')] as any,
            isCollapsed: () => false,
            normalizeError: () => 'e',
            fallbackError: 'failed',
            initialRequestedPaths: ['a.ts'],
        }));

        expect(hook.getCurrent().requestedPaths).toEqual(['a.ts']);
        hook.unmount();
    });

    it('updates requestedPaths from onViewableItemsChanged even when prefetch is disabled', async () => {
        const { useChangedFilesReviewPrefetch } = await import('./useChangedFilesReviewPrefetch');

        const hook = await renderHook(() => useChangedFilesReviewPrefetch({
            sessionId: 's1',
            snapshotSignature: null,
            diffArea: 'pending' as any,
            rows: [{ kind: 'file', file: file('a.ts') }, { kind: 'file', file: file('b.ts') }] as any,
            reviewFiles: [file('a.ts'), file('b.ts')] as any,
            isCollapsed: () => false,
            normalizeError: () => 'e',
            fallbackError: 'failed',
            initialRequestedPaths: ['a.ts'],
        }));

        act(() => {
            hook.getCurrent().onViewableItemsChanged({ viewableItems: [{ index: 1 }] });
        });
        await act(async () => {
            await flushAsync(4);
        });

        expect(hook.getCurrent().requestedPaths).toEqual(['b.ts']);
        hook.unmount();
    });
});
