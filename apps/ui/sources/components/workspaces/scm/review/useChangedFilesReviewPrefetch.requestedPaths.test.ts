import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from './filesContentTestHelpers';

let prefetchConcurrencySetting: number | null = null;


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFilesContentCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'scmReviewPrefetchConcurrency') return prefetchConcurrencySetting;
                if (key === 'scmReviewPrefetchAheadCountWeb') return 1;
                if (key === 'scmReviewPrefetchBehindCountWeb') return 0;
                if (key === 'scmReviewPrefetchAheadCountNative') return 1;
                if (key === 'scmReviewPrefetchBehindCountNative') return 0;
                if (key === 'scmReviewPrefetchDebounceMs') return 0;
                return null;
            },
        });
    },
});

const prefetchDiffSpy = vi.fn(async (input: { path: string }) => ({
    success: true as const,
    diff:
        `diff --git a/${input.path} b/${input.path}\n` +
        `--- a/${input.path}\n` +
        `+++ b/${input.path}\n` +
        '@@ -0,0 +1,1 @@\n' +
        '+prefetched\n',
}));

function file(fullPath: string) {
    return { fullPath } as any;
}

type HookValue = ReturnType<typeof import('./useChangedFilesReviewPrefetch')['useChangedFilesReviewPrefetch']>;

async function renderHook(useValue: () => HookValue): Promise<{ getCurrent: () => HookValue; unmount: () => void }> {
    let current: HookValue | null = null;
    function Test() {
        current = useValue();
        return null;
    }
    let root: renderer.ReactTestRenderer | null = null;
    root = (await renderScreen(React.createElement(Test))).tree;
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
    prefetchConcurrencySetting = null;
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
        await vi.waitFor(() => {
            expect(hook.getCurrent().requestedPaths).toEqual(['b.ts']);
        });
        hook.unmount();
    });

    it('uses a custom diff fetcher for background prefetch', async () => {
        prefetchConcurrencySetting = 2;
        const sessionId = 'workspace:repo:prefetch-custom';
        const { scmDiffCache } = await import('@/scm/diffCache/scmDiffCacheSingleton');
        scmDiffCache.invalidateSession(sessionId);
        const { useChangedFilesReviewPrefetch } = await import('./useChangedFilesReviewPrefetch');

        const hook = await renderHook(() => useChangedFilesReviewPrefetch({
            sessionId,
            snapshotSignature: 'sig-1',
            diffArea: 'pending' as any,
            rows: [
                { kind: 'file', key: 'file:a.ts', sectionKey: 'repository', indexInSection: 0, fileIndex: 0, file: file('a.ts') },
                { kind: 'file', key: 'file:b.ts', sectionKey: 'repository', indexInSection: 1, fileIndex: 1, file: file('b.ts') },
            ] as any,
            reviewFiles: [file('a.ts'), file('b.ts')] as any,
            isCollapsed: () => false,
            normalizeError: () => 'e',
            fallbackError: 'failed',
            initialRequestedPaths: ['a.ts'],
            fetchUnifiedDiffForPath: prefetchDiffSpy,
        } as any));

        act(() => {
            hook.getCurrent().onViewableItemsChanged({ viewableItems: [{ index: 0 }] });
        });

        await vi.waitFor(() => {
            expect(hook.getCurrent().viewableRowIndices).toEqual([0]);
        });
        await vi.waitFor(() => {
            expect(prefetchDiffSpy).toHaveBeenCalledWith(expect.objectContaining({
                path: 'b.ts',
                diffArea: 'pending',
            }));
        });
        hook.unmount();
    });
});
