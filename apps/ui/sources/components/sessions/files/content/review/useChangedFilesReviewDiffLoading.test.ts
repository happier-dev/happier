import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: vi.fn(async (_sessionId: string, input: { path: string; area: ScmDiffArea }) => ({
        success: true,
        diff:
            `diff --git a/${input.path} b/${input.path}\n` +
            `--- a/${input.path}\n` +
            `+++ b/${input.path}\n` +
            `@@ -0,0 +1,1 @@\n` +
            `+change:${input.area}\n`,
    })),
    sessionReadFile: vi.fn(async () => ({ success: false, error: 'nope', content: '' })),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookValue = ReturnType<typeof import('./useChangedFilesReviewDiffLoading')['useChangedFilesReviewDiffLoading']>;

const normalizeError = (v: unknown) => String(v);

async function flushMicrotasks(count = 3): Promise<void> {
    for (let i = 0; i < count; i++) {
        await Promise.resolve();
    }
}

async function flushAsync(count = 3): Promise<void> {
    await flushMicrotasks(count);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(condition: () => boolean, options?: { maxTurns?: number; flushCount?: number }): Promise<void> {
    const maxTurns = options?.maxTurns ?? 25;
    const flushCount = options?.flushCount ?? 6;
    for (let i = 0; i < maxTurns; i++) {
        if (condition()) return;
        await act(async () => {
            await flushAsync(flushCount);
        });
    }
    throw new Error('Timed out waiting for condition');
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

function file(path: string, status: ScmFileStatus['status'] = 'modified'): ScmFileStatus {
    return {
        fullPath: path,
        relativePath: path,
        name: path.split('/').pop() ?? path,
        status,
        isIncluded: false,
        kind: 'file',
        isDeleted: false,
        linesAdded: 1,
        linesRemoved: 1,
    } as any;
}

describe('useChangedFilesReviewDiffLoading', () => {
    it('defaults to fetching only a single diff when requestedPaths is missing', async () => {
        const { sessionScmDiffFile } = await import('@/sync/ops');
        const { useChangedFilesReviewDiffLoading } = await import('./useChangedFilesReviewDiffLoading');

        const reviewFiles = [file('a.ts'), file('b.ts'), file('c.ts')];

        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: 's1',
            isRepo: true,
            reviewFiles,
            diffArea: 'pending',
            // requestedPaths intentionally omitted
            snapshotSignature: 'sig1',
            diffCache: null,
            tooLarge: false,
            selectedPath: '',
            normalizeError,
            fallbackError: 'failed',
        } as any));

        await act(async () => {
            await flushAsync(10);
        });

        // Without explicit requestedPaths, we should avoid fetching every diff up front.
        expect(vi.mocked(sessionScmDiffFile)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sessionScmDiffFile).mock.calls[0]?.[1]).toEqual({ path: 'a.ts', area: 'pending' });

        expect(hook.getCurrent().getDiffState('a.ts').status).toBe('loaded');
        expect(hook.getCurrent().getDiffState('b.ts').status).toBe('idle');
        expect(hook.getCurrent().getDiffState('c.ts').status).toBe('idle');
        hook.unmount();
    });

    it('only fetches diffs for requestedPaths', async () => {
        const { sessionScmDiffFile } = await import('@/sync/ops');
        const { ScmDiffCache } = await import('@/scm/diffCache/scmDiffCache');
        const { useChangedFilesReviewDiffLoading } = await import('./useChangedFilesReviewDiffLoading');

        const reviewFiles = [file('a.ts'), file('b.ts')];
        const diffCache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1_000 });

        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: 's1',
            isRepo: true,
            reviewFiles,
            diffArea: 'pending',
            requestedPaths: ['b.ts'],
            snapshotSignature: 'sig1',
            diffCache,
            tooLarge: false,
            selectedPath: '',
            normalizeError,
            fallbackError: 'failed',
        } as any));

        await act(async () => {
            await flushAsync(12);
        });

        expect(vi.mocked(sessionScmDiffFile)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sessionScmDiffFile).mock.calls[0]?.[1]).toEqual({ path: 'b.ts', area: 'pending' });

        expect(hook.getCurrent().getDiffState('a.ts').status).toBe('idle');
        expect(hook.getCurrent().getDiffState('b.ts').status).toBe('loaded');
        expect(hook.getCurrent().getDiffState('b.ts').diff).toContain('b.ts');
        hook.unmount();
    });

    it('starts fetching multiple requested diffs concurrently when maxConcurrency allows', async () => {
        const { sessionScmDiffFile } = await import('@/sync/ops');
        const { useChangedFilesReviewDiffLoading } = await import('./useChangedFilesReviewDiffLoading');

        const pending: Array<{ resolve: (value: any) => void }> = [];
        vi.mocked(sessionScmDiffFile).mockImplementation(async (_sessionId: string, input: any) => {
            return await new Promise((resolve) => {
                pending.push({
                    resolve: () => resolve({
                        success: true,
                        diff:
                            `diff --git a/${input.path} b/${input.path}\n` +
                            `--- a/${input.path}\n` +
                            `+++ b/${input.path}\n` +
                            `@@ -0,0 +1,1 @@\n` +
                            `+change:${input.area}\n`,
                    }),
                });
            });
        });

        const reviewFiles = [file('a.ts'), file('b.ts')];

        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: 's1',
            isRepo: true,
            reviewFiles,
            diffArea: 'pending',
            requestedPaths: ['a.ts', 'b.ts'],
            snapshotSignature: 'sig1',
            diffCache: null,
            tooLarge: false,
            selectedPath: '',
            maxConcurrency: 2,
            normalizeError,
            fallbackError: 'failed',
        } as any));

        await act(async () => {
            await flushMicrotasks(5);
        });

        // With concurrency, both requests should be in-flight before either resolves.
        expect(vi.mocked(sessionScmDiffFile)).toHaveBeenCalledTimes(2);

        pending.forEach((p) => p.resolve(null));
        await act(async () => {
            await flushAsync(8);
        });

        expect(hook.getCurrent().getDiffState('a.ts').status).toBe('loaded');
        expect(hook.getCurrent().getDiffState('b.ts').status).toBe('loaded');
        hook.unmount();
    });

    it('serves cached diffs without fetching', async () => {
        const { sessionScmDiffFile } = await import('@/sync/ops');
        const { ScmDiffCache } = await import('@/scm/diffCache/scmDiffCache');
        const { useChangedFilesReviewDiffLoading } = await import('./useChangedFilesReviewDiffLoading');

        const reviewFiles = [file('a.ts')];
        const diffCache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1_000 });
        diffCache.set({ sessionId: 's1', snapshotSignature: 'sig1', diffArea: 'pending', path: 'a.ts' }, 'cached-diff');

        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: 's1',
            isRepo: true,
            reviewFiles,
            diffArea: 'pending',
            requestedPaths: ['a.ts'],
            snapshotSignature: 'sig1',
            diffCache,
            tooLarge: false,
            selectedPath: '',
            normalizeError,
            fallbackError: 'failed',
        } as any));

        await act(async () => {
            await flushAsync(5);
        });

        expect(vi.mocked(sessionScmDiffFile)).toHaveBeenCalledTimes(0);
        expect(hook.getCurrent().getDiffState('a.ts').status).toBe('loaded');
        expect(hook.getCurrent().getDiffState('a.ts').diff).toBe('cached-diff');
        hook.unmount();
    });

    it('prunes diff state when requestedPaths shrink', async () => {
        const { useChangedFilesReviewDiffLoading } = await import('./useChangedFilesReviewDiffLoading');

        const reviewFiles = [file('a.ts'), file('b.ts')];
        let requestedPaths: string[] = ['a.ts', 'b.ts'];

        let current: HookValue | null = null;
        function Test() {
            current = useChangedFilesReviewDiffLoading({
                sessionId: 's1',
                isRepo: true,
                reviewFiles,
                diffArea: 'pending',
                requestedPaths,
                snapshotSignature: 'sig1',
                diffCache: null,
                tooLarge: false,
                selectedPath: '',
                normalizeError,
                fallbackError: 'failed',
            } as any);
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Test));
            await flushAsync(16);
        });

        await waitForCondition(() =>
            current!.getDiffState('a.ts').status === 'loaded'
            && current!.getDiffState('b.ts').status === 'loaded',
        );

        expect(current!.getDiffState('a.ts').status).toBe('loaded');
        expect(current!.getDiffState('b.ts').status).toBe('loaded');

        requestedPaths = ['b.ts'];
        await act(async () => {
            tree!.update(React.createElement(Test));
            await flushAsync(3);
        });

        expect(current!.getDiffState('a.ts').status).toBe('idle');
        expect(current!.getDiffState('b.ts').status).toBe('loaded');
    });

    it('fetches diffs for newly requested paths when requestedPaths changes', async () => {
        const { sessionScmDiffFile } = await import('@/sync/ops');
        const { useChangedFilesReviewDiffLoading } = await import('./useChangedFilesReviewDiffLoading');

        const reviewFiles = [file('a.ts'), file('b.ts')];
        let requestedPaths: string[] = ['a.ts'];

        let current: HookValue | null = null;
        function Test() {
            current = useChangedFilesReviewDiffLoading({
                sessionId: 's1',
                isRepo: true,
                reviewFiles,
                diffArea: 'pending',
                requestedPaths,
                snapshotSignature: 'sig1',
                diffCache: null,
                tooLarge: false,
                selectedPath: '',
                normalizeError,
                fallbackError: 'failed',
            } as any);
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Test));
            await flushAsync(16);
        });

        expect(vi.mocked(sessionScmDiffFile)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sessionScmDiffFile).mock.calls[0]?.[1]).toEqual({ path: 'a.ts', area: 'pending' });
        expect(current!.getDiffState('a.ts').status).toBe('loaded');
        expect(current!.getDiffState('b.ts').status).toBe('idle');

        requestedPaths = ['b.ts'];
        await act(async () => {
            tree!.update(React.createElement(Test));
            await flushAsync(16);
        });

        expect(vi.mocked(sessionScmDiffFile)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(sessionScmDiffFile).mock.calls[1]?.[1]).toEqual({ path: 'b.ts', area: 'pending' });
        await waitForCondition(() => current!.getDiffState('b.ts').status === 'loaded');

        expect(current!.getDiffState('b.ts').status).toBe('loaded');
    });
});
