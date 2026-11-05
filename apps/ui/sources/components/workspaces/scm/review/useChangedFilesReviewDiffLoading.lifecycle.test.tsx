import { describe, expect, it, vi } from 'vitest';
import { act, createDeferred, renderHook } from '@/dev/testkit';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
import type { ScmReviewUnifiedDiffFetcher } from './scmReviewDiffFetcher';

const file = (fullPath: string): ScmFileStatus => ({ fullPath, fileName: fullPath, filePath: '',
    status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 });
const normalizeError = String;

describe('Review file-read lifetime', () => {
    it('starts demanded work when the host supplies its read port after mount', async () => {
        let fetchUnifiedDiffForPath: ScmReviewUnifiedDiffFetcher | undefined;
        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: '', isRepo: true, reviewFiles: [file('a.ts')], diffArea: 'pending', requestedPaths: ['a.ts'],
            tooLarge: false, selectedPath: '', normalizeError, fallbackError: 'failed', fetchUnifiedDiffForPath,
        }));
        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').status).toBe('idle');
        fetchUnifiedDiffForPath = async () => ({ success: true, diff: 'ready evidence' });
        await hook.rerender();
        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts')).toMatchObject({ status: 'loaded', diff: 'ready evidence' });
    });
    it('keeps a cancelled read out of failure state and allows explicit Retry', async () => {
        let cancelled = true;
        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: '', isRepo: true, reviewFiles: [file('a.ts')], diffArea: 'pending', requestedPaths: ['a.ts'],
            tooLarge: false, selectedPath: '', normalizeError, fallbackError: 'failed',
            fetchUnifiedDiffForPath: async () => cancelled
                ? { success: false, error: 'Cancelled.', errorCode: 'COMMAND_CANCELLED' }
                : { success: true, diff: 'retried evidence' },
        }));
        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts')).toMatchObject({ status: 'idle', error: null });
        cancelled = false;
        await act(async () => hook.getCurrent().retryDiff('a.ts'));
        await vi.waitFor(() => expect(hook.getCurrent().diffStateSource.getDiffState('a.ts')).toMatchObject({ status: 'loaded', diff: 'retried evidence' }));
    });

    it('retires an admitted captured read on unmount', async () => {
        let signal: AbortSignal | undefined;
        const pending = createDeferred<{ success: false; error: string; errorCode: string }>();
        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: '', isRepo: true, reviewFiles: [file('a.ts')], diffArea: 'pending', requestedPaths: ['a.ts'],
            tooLarge: false, selectedPath: '', normalizeError, fallbackError: 'failed',
            fetchUnifiedDiffForPath: async input => { signal = input.signal; return pending.promise; },
        }));
        expect(signal?.aborted).toBe(false);
        await hook.unmount();
        expect(signal?.aborted).toBe(true);
        await act(async () => pending.resolve({ success: false, error: 'Cancelled.', errorCode: 'COMMAND_CANCELLED' }));
    });
    it('retains a failed file read code in the Review state', async () => {
        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: '', isRepo: true, reviewFiles: [file('a.ts')], diffArea: 'pending', requestedPaths: ['a.ts'],
            tooLarge: false, selectedPath: '', normalizeError, fallbackError: 'failed',
            fetchUnifiedDiffForPath: async () => ({ success: false, error: 'Disconnected.', errorCode: 'RPC_TRANSPORT_UNAVAILABLE' }),
        }));
        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts')).toMatchObject({
            status: 'error', errorCode: 'RPC_TRANSPORT_UNAVAILABLE',
        });
    });

    it('keeps pending demanded reads across hydration and drops queued offscreen work', async () => {
        const pending = createDeferred<{ success: true; diff: string }>();
        // Host-provided file-read boundary; the queue, state and lifecycle remain real.
        const fetchUnifiedDiffForPath = vi.fn(async () => pending.promise);
        let requestedPaths = ['a.ts', 'b.ts'];
        let providerDiffByPath: ReadonlyMap<string, string | null> = new Map();
        const reviewFiles = [file('a.ts'), file('b.ts')];
        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: '', isRepo: true, reviewFiles, diffArea: 'pending', requestedPaths,
            providerDiffByPath, fetchUnifiedDiffForPath, snapshotSignature: 'captured', diffCache: null,
            tooLarge: false, selectedPath: '', normalizeError, fallbackError: 'failed', maxConcurrency: 1,
        }));
        expect(fetchUnifiedDiffForPath).toHaveBeenCalledTimes(1);
        providerDiffByPath = new Map([['unrelated.ts', 'hydrated']]);
        await hook.rerender();
        expect(fetchUnifiedDiffForPath).toHaveBeenCalledTimes(1);
        requestedPaths = ['a.ts'];
        await hook.rerender();
        await act(async () => pending.resolve({ success: true, diff: 'captured a' }));
        await vi.waitFor(() => expect(hook.getCurrent().diffStateSource.getDiffState('a.ts')).toMatchObject({ status: 'loaded', diff: 'captured a' }));
        expect(fetchUnifiedDiffForPath).toHaveBeenCalledTimes(1);
    });
});
