import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { useChangedFilesReviewPrefetch } from './useChangedFilesReviewPrefetch';
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

afterEach(() => {
    prefetchConcurrencySetting = null;
    vi.clearAllMocks();
});

describe('useChangedFilesReviewPrefetch (requestedPaths)', () => {
    it('returns initialRequestedPaths before viewability updates', async () => {

        const hook = await renderHook(() => useChangedFilesReviewPrefetch({
            sessionId: 's1',
            snapshotSignature: null,
            diffArea: 'pending' as any,
            rows: [{ kind: 'file', file: file('a.ts') }, { kind: 'file', file: file('b.ts') }] as any,
            reviewFiles: [file('a.ts'), file('b.ts')] as any,
            isCollapsed: () => false,
            normalizeError: () => 'e',
            fallbackError: 'failed',
            initialRequestedPaths: ['a.ts', 'b.ts'],
        }));

        expect(hook.getCurrent().requestedPaths).toEqual(['a.ts']);
        await hook.unmount();
    });

    it('updates requestedPaths from onViewableItemsChanged even when prefetch is disabled', async () => {

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
        await hook.unmount();
    });

    it.each(['', 'captured-session'])('leaves custom file-read acquisition to the demand loader (Session: %s)', async (readSessionId) => {
        prefetchConcurrencySetting = 2;
        const sessionId = 'workspace:repo:prefetch-custom';
        const { scmDiffCache } = await import('@/scm/diffCache/scmDiffCacheSingleton');
        scmDiffCache.invalidateSession(sessionId);

        const hook = await renderHook(() => useChangedFilesReviewPrefetch({
            sessionId: readSessionId,
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
            expect(hook.getCurrent().requestedPaths).toEqual(['a.ts']);
        });
        expect(prefetchDiffSpy).not.toHaveBeenCalled();
        act(() => { hook.getCurrent().onViewableItemsChanged({ viewableItems: [{ index: 1 }] }); });
        await vi.waitFor(() => { expect(hook.getCurrent().requestedPaths).toEqual(['b.ts']); });
        expect(prefetchDiffSpy).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('requests nothing when the visible viewport contains only a section header', async () => {
        const hook = await renderHook(() => useChangedFilesReviewPrefetch({
            sessionId: 's1', snapshotSignature: 'collapsed', diffArea: 'pending',
            rows: [{ kind: 'section', key: 'section', title: 'Changes' }, { kind: 'file', file: file('b.ts') }] as any,
            reviewFiles: [file('a.ts'), file('b.ts')], isCollapsed: () => false,
            normalizeError: () => 'e', fallbackError: 'failed', initialRequestedPaths: ['a.ts'],
        }));
        act(() => { hook.getCurrent().onViewableItemsChanged({ viewableItems: [{ index: 0 }] }); });
        await vi.waitFor(() => { expect(hook.getCurrent().viewableRowIndices).toEqual([0]); });
        expect(hook.getCurrent().requestedPaths).toEqual([]);
        await hook.unmount();
    });
});
