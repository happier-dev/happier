import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

type HookValue = ReturnType<typeof import('./useChangedFilesReviewCollapsedPaths')['useChangedFilesReviewCollapsedPaths']>;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsync(count = 3): Promise<void> {
    for (let i = 0; i < count; i++) {
        await Promise.resolve();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

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
            act(() => {
                root?.unmount();
            });
        },
    };
}

afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
});

function file(path: string): ScmFileStatus {
    return {
        fullPath: path,
        relativePath: path,
        name: path.split('/').pop() ?? path,
        status: 'modified',
        isIncluded: false,
        kind: 'file',
        isDeleted: false,
        linesAdded: 1,
        linesRemoved: 1,
    };
}

describe('useChangedFilesReviewCollapsedPaths', () => {
    it('persists collapsed paths whenever they change', async () => {
        const onCollapsedPathsChange = vi.fn();
        const { useChangedFilesReviewCollapsedPaths } = await import('./useChangedFilesReviewCollapsedPaths');
        const hook = await renderHook(() =>
            useChangedFilesReviewCollapsedPaths({
                reviewFiles: [file('a.txt'), file('b.txt')],
                initialCollapsedPaths: ['a.txt'],
                onCollapsedPathsChange,
            })
        );

        await act(async () => {
            await flushAsync();
        });
        expect(onCollapsedPathsChange).toHaveBeenCalledWith(['a.txt']);

        await act(async () => {
            hook.getCurrent().toggleCollapsed('a.txt');
            await flushAsync();
        });
        expect(onCollapsedPathsChange).toHaveBeenCalledWith([]);

        await act(async () => {
            hook.getCurrent().toggleCollapsed('b.txt');
            await flushAsync();
        });
        expect(onCollapsedPathsChange).toHaveBeenCalledWith(['b.txt']);
        hook.unmount();
    });
});
