import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';

import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { act, createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { ScmDiffCache } from '@/scm/diffCache/scmDiffCache';
import { fetchWorkspaceUnifiedDiffForPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit');
    return createServerScopedMachineRpcBoundaryMock(vi.fn(async ({ payload }) => {
        // The external RPC payload is the real SCM file-diff request.
        const input = payload as { path: string; area: ScmDiffArea };
        return {
            success: true,
            diff:
                `diff --git a/${input.path} b/${input.path}\n` +
                `--- a/${input.path}\n` +
                `+++ b/${input.path}\n` +
                `@@ -0,0 +1,1 @@\n` +
                `+change:${input.area}\n`,
        };
    }));
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const settings = settingsParse({});
    const metadata = createSessionFixture().metadata!;
    const session = createSessionFixture({ id: 's1', metadata: { ...metadata, machineId: 'm1', path: '/repo' } });
    return createStorageModuleStub({ storage: { getState: () => ({
        settings, sessions: { s1: session }, machines: { m1: createMachineFixture({ id: 'm1' }) },
        getProjectForSession: () => null,
    }) } });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => ({ serverId: 'server', serverUrl: 'https://example.com', generation: 1 }),
}));

type HookValue = ReturnType<typeof import('./useChangedFilesReviewDiffLoading')['useChangedFilesReviewDiffLoading']>;

const normalizeError = (v: unknown) => String(v);

async function waitForCondition(condition: () => boolean): Promise<void> {
    await vi.waitFor(() => expect(condition()).toBe(true));
}

afterEach(() => {
    vi.resetAllMocks();
    // Keep the real runtime graph collected once; resetting modules made each
    // test re-import it and let timed-out imports outlive their owning test.
});

function file(path: string, status: ScmFileStatus['status'] = 'modified'): ScmFileStatus {
    return {
        fullPath: path,
        filePath: '',
        fileName: path.split('/').pop() ?? path,
        status,
        isIncluded: false,
        linesAdded: 1,
        linesRemoved: 1,
    };
}

describe('useChangedFilesReviewDiffLoading', () => {
    it('does not request an anchor when the viewport explicitly demands no diffs', async () => {
        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: 's1', isRepo: true, reviewFiles: [file('a.ts')], diffArea: 'pending',
            requestedPaths: [], snapshotSignature: 'empty-demand', diffCache: null,
            tooLarge: false, selectedPath: '', normalizeError, fallbackError: 'failed',
        }));
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').status).toBe('idle');
        await hook.unmount();
    });

    it('defaults to fetching only a single diff when requestedPaths is missing', async () => {

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
        }));

        await waitForCondition(() => ['loaded', 'error'].includes(hook.getCurrent().diffStateSource.getDiffState('a.ts').status));
        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts')).toMatchObject({ status: 'loaded', error: null });

        // Without explicit requestedPaths, we should avoid fetching every diff up front.
        expect(vi.mocked(machineRpcWithServerScope)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(machineRpcWithServerScope).mock.calls[0]?.[0]?.payload).toEqual(expect.objectContaining({ path: 'a.ts', area: 'pending', cwd: '/repo' }));

        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').status).toBe('loaded');
        expect(hook.getCurrent().diffStateSource.getDiffState('b.ts').status).toBe('idle');
        expect(hook.getCurrent().diffStateSource.getDiffState('c.ts').status).toBe('idle');
        await hook.unmount();
    });

    it('keeps a validated snapshot across elapsed time and unrelated renders', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        let reviewFiles = [file('a.ts')];
        function Test() {
            useChangedFilesReviewDiffLoading({
                sessionId: 's1', isRepo: true, reviewFiles, diffArea: 'pending',
                requestedPaths: ['a.ts'], snapshotSignature: 'unchanged', diffCache: null,
                minRefetchMs: 60_000, tooLarge: false, selectedPath: '', normalizeError, fallbackError: 'failed',
            });
            return null;
        }
        const screen = await renderScreen(React.createElement(Test));
        try {
            expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
            now.mockReturnValue(121_000);
            reviewFiles = [...reviewFiles];
            await screen.update(React.createElement(Test));
            expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
        } finally {
            await screen.unmount();
            now.mockRestore();
        }
    });

    it('shares pending workspace RPCs across rerenders and revalidates a new snapshot', async () => {
        const scope = { serverId: 'server', machineId: 'm1', rootPath: '/repo' };
        const diffCache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1 });
        const pending = createDeferred<{ success: true; diff: string }>();
        vi.mocked(machineRpcWithServerScope).mockImplementationOnce(async () => pending.promise);
        const hook = await renderHook(({ signature }) => useChangedFilesReviewDiffLoading({
            sessionId: '', reviewScopeKey: 'workspace:repo', isRepo: true, reviewFiles: [file('a.ts')],
            diffArea: 'pending', requestedPaths: ['a.ts'], snapshotSignature: signature, diffCache,
            tooLarge: false, selectedPath: '', normalizeError, fallbackError: 'failed',
            fetchUnifiedDiffForPath: input => fetchWorkspaceUnifiedDiffForPath({ ...input, scope }),
        }), { initialProps: { signature: 'workspace-first' } });
        try {
            await hook.rerender({ signature: 'workspace-first' });
            expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
            await act(async () => pending.resolve({ success: true, diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' }));
            await vi.waitFor(() => expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').status).toBe('loaded'));
            await hook.rerender({ signature: 'workspace-first' });
            expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
            await hook.rerender({ signature: 'workspace-second' });
            await vi.waitFor(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').diff).toContain('+change:pending'));
        } finally {
            await hook.unmount();
        }
    });

    it('only fetches diffs for requestedPaths', async () => {

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
        }));

        await waitForCondition(() => vi.mocked(machineRpcWithServerScope).mock.calls.length === 1);

        expect(vi.mocked(machineRpcWithServerScope)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(machineRpcWithServerScope).mock.calls[0]?.[0]?.payload).toEqual(expect.objectContaining({ path: 'b.ts', area: 'pending', cwd: '/repo' }));

        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').status).toBe('idle');
        expect(hook.getCurrent().diffStateSource.getDiffState('b.ts').status).toBe('loaded');
        expect(hook.getCurrent().diffStateSource.getDiffState('b.ts').diff).toContain('b.ts');
        await hook.unmount();
    });

    it('uses a custom diff fetcher when provided', async () => {

        const customFetchUnifiedDiffForPath = vi.fn(async (input: {
            path: string;
            diffArea: ScmDiffArea;
            file: ScmFileStatus | null;
            normalizeError: (value: unknown) => string;
            fallbackError: string;
        }) => ({
            success: true as const,
            diff:
                `diff --git a/${input.path} b/${input.path}\n` +
                `--- a/${input.path}\n` +
                `+++ b/${input.path}\n` +
                `@@ -0,0 +1,1 @@\n` +
                `+workspace:${input.diffArea}\n`,
        }));

        const reviewFiles = [file('workspace.ts')];

        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: 'workspace:repo',
            isRepo: true,
            reviewFiles,
            diffArea: 'both',
            requestedPaths: ['workspace.ts'],
            snapshotSignature: 'sig1',
            diffCache: null,
            tooLarge: false,
            selectedPath: '',
            fetchUnifiedDiffForPath: customFetchUnifiedDiffForPath,
            normalizeError,
            fallbackError: 'failed',
        }));

        await waitForCondition(() => customFetchUnifiedDiffForPath.mock.calls.length === 1);

        expect(customFetchUnifiedDiffForPath).toHaveBeenCalledWith(expect.objectContaining({
            path: 'workspace.ts',
            diffArea: 'both',
            file: expect.objectContaining({ fullPath: 'workspace.ts' }),
        }));
        expect(vi.mocked(machineRpcWithServerScope)).not.toHaveBeenCalled();
        expect(hook.getCurrent().diffStateSource.getDiffState('workspace.ts').status).toBe('loaded');
        expect(hook.getCurrent().diffStateSource.getDiffState('workspace.ts').diff).toContain('workspace.ts');
        await hook.unmount();
    });

    it('starts fetching multiple requested diffs concurrently when maxConcurrency allows', async () => {

        const pending: Array<{ resolve: () => void }> = [];
        vi.mocked(machineRpcWithServerScope).mockImplementation(async (request) => {
            // RPC boundary payload in this test is the SCM file-diff request.
            const input = request.payload as { path: string; area: ScmDiffArea };
            return await new Promise<{ success: true; diff: string }>((resolve) => {
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
        }));

        await waitForCondition(() => vi.mocked(machineRpcWithServerScope).mock.calls.length === 2);

        await act(async () => pending.forEach((p) => p.resolve()));
        await waitForCondition(() =>
            hook.getCurrent().diffStateSource.getDiffState('a.ts').status === 'loaded'
            && hook.getCurrent().diffStateSource.getDiffState('b.ts').status === 'loaded',
        );

        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').status).toBe('loaded');
        expect(hook.getCurrent().diffStateSource.getDiffState('b.ts').status).toBe('loaded');
        await hook.unmount();
    });

    it('serves cached diffs without fetching', async () => {

        const scope = { serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' };
        const reviewFiles = [file('a.ts')];
        const diffCache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1_000 });
        diffCache.set({ sessionId: buildWorkspaceCacheKey(scope), snapshotSignature: 'sig1', diffArea: 'pending', path: 'a.ts' }, 'cached-diff');

        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({
            sessionId: 's1',
            isRepo: true,
            reviewFiles,
            diffArea: 'pending',
            requestedPaths: ['a.ts'],
            snapshotSignature: 'sig1',
            diffCache,
            fetchUnifiedDiffForPath: (input) => fetchWorkspaceUnifiedDiffForPath({ ...input, scope }),
            tooLarge: false,
            selectedPath: '',
            normalizeError,
            fallbackError: 'failed',
        }));

        await waitForCondition(() => hook.getCurrent().diffStateSource.getDiffState('a.ts').status === 'loaded');

        expect(vi.mocked(machineRpcWithServerScope)).toHaveBeenCalledTimes(0);
        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').status).toBe('loaded');
        expect(hook.getCurrent().diffStateSource.getDiffState('a.ts').diff).toBe('cached-diff');
        await hook.unmount();
    });

    it('keeps already loaded diffs when requestedPaths shrink', async () => {

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
            });
            return null;
        }

        const screen = await renderScreen(React.createElement(Test));

        await vi.waitFor(() => expect([
            current!.diffStateSource.getDiffState('a.ts'),
            current!.diffStateSource.getDiffState('b.ts'),
        ]).toMatchObject([{ status: 'loaded' }, { status: 'loaded' }]));

        expect(current!.diffStateSource.getDiffState('a.ts').status).toBe('loaded');
        expect(current!.diffStateSource.getDiffState('b.ts').status).toBe('loaded');

        requestedPaths = ['b.ts'];
        await screen.update(React.createElement(Test));

        await waitForCondition(() =>
            current!.diffStateSource.getDiffState('a.ts').status === 'loaded'
            && current!.diffStateSource.getDiffState('b.ts').status === 'loaded',
        );

        expect(current!.diffStateSource.getDiffState('a.ts').status).toBe('loaded');
        expect(current!.diffStateSource.getDiffState('b.ts').status).toBe('loaded');
        await screen.unmount();
    });

    it('fetches diffs for newly requested paths when requestedPaths changes', async () => {

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
            });
            return null;
        }

        const screen = await renderScreen(React.createElement(Test));

        expect(vi.mocked(machineRpcWithServerScope)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(machineRpcWithServerScope).mock.calls[0]?.[0]?.payload).toEqual(expect.objectContaining({ path: 'a.ts', area: 'pending', cwd: '/repo' }));
        expect(current!.diffStateSource.getDiffState('a.ts').status).toBe('loaded');
        expect(current!.diffStateSource.getDiffState('b.ts').status).toBe('idle');

        requestedPaths = ['b.ts'];
        await screen.update(React.createElement(Test));

        await waitForCondition(() => vi.mocked(machineRpcWithServerScope).mock.calls.length === 2);
        expect(vi.mocked(machineRpcWithServerScope).mock.calls[1]?.[0]?.payload).toEqual(expect.objectContaining({ path: 'b.ts', area: 'pending', cwd: '/repo' }));
        await waitForCondition(() => current!.diffStateSource.getDiffState('b.ts').status === 'loaded');

        expect(current!.diffStateSource.getDiffState('b.ts').status).toBe('loaded');
        await screen.unmount();
    });
});
