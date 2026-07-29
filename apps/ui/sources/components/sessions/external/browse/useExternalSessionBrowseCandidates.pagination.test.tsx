import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const candidatesListSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionsCandidatesList: (...args: unknown[]) => candidatesListSpy(...args),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const params = {
    machineId: 'machine-1',
    providerId: 'codex' as const,
    source: { kind: 'codexHome' as const, home: 'user' as const },
};

function page(
    candidates: readonly Readonly<{
        remoteSessionId: string;
        title?: string;
        updatedAtMs: number;
        details?: Record<string, unknown>;
        candidateKey?: string;
        linkData?: Readonly<Record<string, unknown>>;
        linkedSessionId?: string;
        imported?: boolean;
        materializedThrough?: number;
    }>[],
    nextCursor: string | null,
) {
    return { ok: true, candidates, nextCursor } as const;
}

function preparationPage(scanned: number, total?: number) {
    return {
        ok: true,
        candidates: [],
        nextCursor: null,
        preparation: {
            kind: 'building_candidate_index' as const,
            scanned,
            ...(total === undefined ? {} : { total }),
        },
    } as const;
}

function policyScope(sourcePolicyId: `es-source-policy:v1:${string}`) {
    return {
        qualifiedIdentity: {
            agent: { pluginId: 'plugin-a', localId: 'codex' },
            source: { kind: 'codexHome', contractVersion: 1 as const },
        },
        sourcePolicyId,
    } as const;
}

describe('useExternalSessionBrowseCandidates pagination', () => {
    beforeEach(() => {
        candidatesListSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('admits only one same-tick request for each scope and cursor', async () => {
        const nextPage = createDeferred<ReturnType<typeof page>>();
        candidatesListSpy
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'one', title: 'One', updatedAtMs: 1 },
            ], 'cursor-1'))
            .mockImplementationOnce(() => nextPage.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await act(async () => {
            void hook.getCurrent().loadMore();
            void hook.getCurrent().loadMore();
        });

        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
        expect(candidatesListSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: 'cursor-1' }),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );

        nextPage.resolve(page([], null));
        await flushHookEffects();
    });

    it('identity-merges page mutations and keeps loaded rows visible after a page failure', async () => {
        candidatesListSpy
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'one', title: 'Old title', updatedAtMs: 1, details: { path: '/repo' } },
            ], 'cursor-1'))
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'one', title: 'New title', updatedAtMs: 2, details: { linked: true } },
                { remoteSessionId: 'two', title: 'Two', updatedAtMs: 1 },
            ], 'cursor-2'))
            .mockRejectedValueOnce(new Error('next page failed'));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await act(async () => {
            await hook.getCurrent().loadMore();
        });
        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({
                remoteSessionId: 'one',
                title: 'New title',
                details: { path: '/repo', linked: true },
            }),
            expect.objectContaining({ remoteSessionId: 'two' }),
        ]);

        await act(async () => {
            await hook.getCurrent().loadMore();
        });
        expect(hook.getCurrent().error).toBe('externalSessions.browseFailedToLoad');
        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['one', 'two']);
        expect(hook.getCurrent().nextCursor).toBe('cursor-2');
    });

    it('preserves canonical link and import annotations from the daemon response', async () => {
        candidatesListSpy.mockResolvedValueOnce(page([{
            remoteSessionId: 'one',
            updatedAtMs: 1,
            linkedSessionId: 'session-one',
            imported: true,
            materializedThrough: 100,
        }], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));
        await flushHookEffects();

        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({
                linkedSessionId: 'session-one',
                imported: true,
                materializedThrough: 100,
            }),
        ]);
    });

    it('identity-merges duplicate candidates within the root replacement page', async () => {
        candidatesListSpy.mockResolvedValueOnce(page([
            { remoteSessionId: 'one', title: 'Old title', updatedAtMs: 1, details: { path: '/repo' } },
            { remoteSessionId: 'one', title: 'New title', updatedAtMs: 2, details: { linked: true } },
        ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({
                remoteSessionId: 'one',
                title: 'New title',
                updatedAtMs: 2,
                details: { path: '/repo', linked: true },
            }),
        ]);
    });

    it('keeps project-qualified candidates distinct when their native ids collide', async () => {
        candidatesListSpy.mockResolvedValueOnce(page([
            {
                remoteSessionId: 'duplicate-native-id',
                candidateKey: 'project-a-key',
                linkData: { projectId: 'project-a' },
                title: 'Project A',
                updatedAtMs: 2,
            },
            {
                remoteSessionId: 'duplicate-native-id',
                candidateKey: 'project-b-key',
                linkData: { projectId: 'project-b' },
                title: 'Project B',
                updatedAtMs: 1,
            },
        ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({ candidateKey: 'project-a-key', title: 'Project A' }),
            expect.objectContaining({ candidateKey: 'project-b-key', title: 'Project B' }),
        ]);
    });

    it('preserves the daemon candidate order for equal timestamps', async () => {
        candidatesListSpy.mockResolvedValueOnce(page([
            {
                remoteSessionId: 'z-session',
                candidateKey: 'z-key',
                updatedAtMs: 10,
            },
            {
                remoteSessionId: 'ä-session',
                candidateKey: 'ä-key',
                updatedAtMs: 10,
            },
        ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'z-session',
            'ä-session',
        ]);
    });

    it('ends pagination when a source returns a cursor cycle', async () => {
        candidatesListSpy
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'one', title: 'One', updatedAtMs: 1 },
            ], 'cursor-1'))
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'two', title: 'Two', updatedAtMs: 2 },
            ], 'cursor-1'));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await act(async () => {
            await hook.getCurrent().loadMore();
        });

        expect(hook.getCurrent().nextCursor).toBeNull();
        await act(async () => {
            await hook.getCurrent().loadMore();
        });
        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
    });

    it('fences an in-flight page when the browse scope changes and clears page loading state', async () => {
        const stalePage = createDeferred<ReturnType<typeof page>>();
        candidatesListSpy
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'old-root', title: 'Old root', updatedAtMs: 1 },
            ], 'old-cursor'))
            .mockImplementationOnce(() => stalePage.promise)
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'new-root', title: 'New root', updatedAtMs: 2 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(
            (hookParams: typeof params) => useExternalSessionBrowseCandidates(hookParams),
            { initialProps: params },
        );

        await act(async () => {
            void hook.getCurrent().loadMore();
        });
        expect(hook.getCurrent().loadingMore).toBe(true);

        await hook.rerender({ ...params, machineId: 'machine-2' });

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['new-root']);
        expect(hook.getCurrent().loadingMore).toBe(false);

        stalePage.resolve(page([
            { remoteSessionId: 'stale-page', title: 'Stale page', updatedAtMs: 3 },
        ], null));
        await flushHookEffects();

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['new-root']);
    });

    it('hides the previous source policy while a changed scope is loading', async () => {
        const nextScopePage = createDeferred<ReturnType<typeof page> & {
            autoLinkPolicyScopeV1: ReturnType<typeof policyScope>;
        }>();
        const firstScope = policyScope(`es-source-policy:v1:${'a'.repeat(64)}`);
        const secondScope = policyScope(`es-source-policy:v1:${'b'.repeat(64)}`);
        candidatesListSpy
            .mockResolvedValueOnce({
                ...page([], null),
                autoLinkPolicyScopeV1: firstScope,
            })
            .mockImplementationOnce(() => nextScopePage.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(
            (hookParams: typeof params) => useExternalSessionBrowseCandidates(hookParams),
            { initialProps: params },
        );

        expect(hook.getCurrent().autoLinkPolicyScope).toEqual(firstScope);

        await hook.rerender({ ...params, machineId: 'machine-2' });

        expect(hook.getCurrent().autoLinkPolicyScope).toBeNull();
        expect(hook.getCurrent().loading).toBe(true);

        nextScopePage.resolve({
            ...page([], null),
            autoLinkPolicyScopeV1: secondScope,
        });
        await flushHookEffects();

        expect(hook.getCurrent().autoLinkPolicyScope).toEqual(secondScope);
    });

    it('starts a fresh root request when filters rebound to an aborted scope', async () => {
        const firstScopePage = createDeferred<ReturnType<typeof page>>();
        const secondScopePage = createDeferred<ReturnType<typeof page>>();
        candidatesListSpy
            .mockImplementationOnce(() => firstScopePage.promise)
            .mockImplementationOnce(() => secondScopePage.promise)
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'fresh-root', title: 'Fresh root', updatedAtMs: 3 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(
            (hookParams: typeof params) => useExternalSessionBrowseCandidates(hookParams),
            { initialProps: params },
        );

        await hook.rerender({ ...params, machineId: 'machine-2' });
        await hook.rerender(params);

        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({ remoteSessionId: 'fresh-root' }),
        ]);

        firstScopePage.resolve(page([
            { remoteSessionId: 'stale-first-scope', updatedAtMs: 1 },
        ], null));
        secondScopePage.resolve(page([
            { remoteSessionId: 'stale-second-scope', updatedAtMs: 2 },
        ], null));
        await flushHookEffects();

        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({ remoteSessionId: 'fresh-root' }),
        ]);
    });

    it('continues bounded cold-index root requests while exposing preparation progress', async () => {
        const completedPage = createDeferred<ReturnType<typeof page>>();
        candidatesListSpy
            .mockResolvedValueOnce(preparationPage(50, 100))
            .mockResolvedValueOnce(preparationPage(100, 100))
            .mockImplementationOnce(() => completedPage.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(candidatesListSpy.mock.calls.map(([request]) => request)).toEqual([
            expect.not.objectContaining({ cursor: expect.anything() }),
            expect.not.objectContaining({ cursor: expect.anything() }),
            expect.not.objectContaining({ cursor: expect.anything() }),
        ]);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [],
            loading: true,
            preparation: {
                kind: 'building_candidate_index',
                scanned: 100,
                total: 100,
            },
        });

        completedPage.resolve(page([
            { remoteSessionId: 'ready', title: 'Ready', updatedAtMs: 3 },
        ], 'cursor-1'));
        await flushHookEffects();

        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'ready' })],
            loading: false,
            preparation: null,
            nextCursor: 'cursor-1',
        });
    });

    it('stops a cold-index continuation that makes no preparation progress', async () => {
        candidatesListSpy
            .mockResolvedValueOnce(preparationPage(50, 100))
            .mockResolvedValueOnce(preparationPage(50, 100))
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'must-not-publish', updatedAtMs: 4 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [],
            loading: false,
            preparation: null,
            error: 'externalSessions.browseFailedToLoad',
        });
    });

    it('aborts and fences cold-index continuation when the hook unmounts', async () => {
        const nextChunk = createDeferred<ReturnType<typeof preparationPage>>();
        const observedSignals: AbortSignal[] = [];
        candidatesListSpy
            .mockImplementationOnce((_request, opts: Readonly<{ signal?: AbortSignal }>) => {
                if (opts.signal) observedSignals.push(opts.signal);
                return Promise.resolve(preparationPage(50, 100));
            })
            .mockImplementationOnce((_request, opts: Readonly<{ signal?: AbortSignal }>) => {
                if (opts.signal) observedSignals.push(opts.signal);
                return nextChunk.promise;
            });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
        expect(observedSignals).toHaveLength(2);
        expect(observedSignals.every((signal) => !signal.aborted)).toBe(true);

        await hook.unmount();

        expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
        nextChunk.resolve(preparationPage(100, 100));
        await flushHookEffects();
        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
    });

    it('cancels cold-index continuation without exposing partial candidates and allows retry', async () => {
        const nextChunk = createDeferred<ReturnType<typeof preparationPage>>();
        const observedSignals: AbortSignal[] = [];
        candidatesListSpy
            .mockImplementationOnce((_request, opts: Readonly<{ signal?: AbortSignal }>) => {
                if (opts.signal) observedSignals.push(opts.signal);
                return Promise.resolve(preparationPage(50, 100));
            })
            .mockImplementationOnce((_request, opts: Readonly<{ signal?: AbortSignal }>) => {
                if (opts.signal) observedSignals.push(opts.signal);
                return nextChunk.promise;
            })
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'recovered', title: 'Recovered', updatedAtMs: 4 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(hook.getCurrent()).toMatchObject({
            candidates: [],
            loading: true,
            preparation: {
                kind: 'building_candidate_index',
                scanned: 50,
                total: 100,
            },
        });

        await act(async () => {
            hook.getCurrent().cancelPreparation();
        });

        expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [],
            loading: false,
            preparation: null,
            error: 'externalSessions.browseIndexingCancelled',
        });

        nextChunk.resolve(preparationPage(100, 100));
        await flushHookEffects();
        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().candidates).toEqual([]);

        await act(async () => {
            await hook.getCurrent().reload();
        });
        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'recovered' })],
            error: null,
        });
    });

    it('shows a cold-index failure, then retries from the bounded root request', async () => {
        candidatesListSpy
            .mockResolvedValueOnce(preparationPage(50))
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'internal_error',
                error: 'Index build failed',
            })
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'recovered', title: 'Recovered', updatedAtMs: 4 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(hook.getCurrent()).toMatchObject({
            candidates: [],
            error: 'externalSessions.browseFailedToLoad',
            loading: false,
            preparation: null,
        });

        await act(async () => {
            await hook.getCurrent().reload();
        });

        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(candidatesListSpy).toHaveBeenLastCalledWith(
            expect.not.objectContaining({ cursor: expect.anything() }),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'recovered' })],
            error: null,
            preparation: null,
        });
    });

    it('returns a warm root page after one request', async () => {
        candidatesListSpy.mockResolvedValueOnce(page([
            { remoteSessionId: 'warm', title: 'Warm', updatedAtMs: 5 },
        ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'warm' })],
            loading: false,
            preparation: null,
        });
    });

    it('keeps one in-flight search when an equivalent source object is rematerialized', async () => {
        const fastPage = createDeferred<ReturnType<typeof page> & Readonly<{
            searchIncomplete: true;
        }>>();
        candidatesListSpy
            .mockImplementationOnce(() => fastPage.promise)
            .mockResolvedValueOnce(page([
                {
                    remoteSessionId: 'full-match',
                    title: 'Initial QA Response',
                    updatedAtMs: 6,
                },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const initialParams = {
            ...params,
            searchTerm: 'Initial QA Response',
        };
        const hook = await renderHook(
            (hookParams: typeof initialParams) => useExternalSessionBrowseCandidates(hookParams),
            { initialProps: initialParams },
        );

        expect(candidatesListSpy).toHaveBeenCalledTimes(1);
        await hook.rerender({
            ...initialParams,
            source: { ...initialParams.source },
        });
        expect(candidatesListSpy).toHaveBeenCalledTimes(1);

        fastPage.resolve({
            ...page([], 'fast-cursor'),
            searchIncomplete: true,
        });
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
        expect(candidatesListSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({
                searchMode: 'full',
                searchTerm: 'Initial QA Response',
            }),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(hook.getCurrent()).toMatchObject({
            candidates: [
                expect.objectContaining({
                    remoteSessionId: 'full-match',
                    title: 'Initial QA Response',
                }),
            ],
            error: null,
            loading: false,
        });
    });

    it('continues empty incomplete full-search pages until a matching candidate is reachable', async () => {
        candidatesListSpy
            .mockResolvedValueOnce({
                ...page([], 'fast-cursor'),
                searchIncomplete: true,
            })
            .mockResolvedValueOnce({
                ...page([], 'full-cursor'),
                searchIncomplete: true,
            })
            .mockResolvedValueOnce(page([
                {
                    remoteSessionId: 'deep-match',
                    title: 'Continuity proof marker WINDOWS_FINAL',
                    updatedAtMs: 6,
                },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates({
            ...params,
            searchTerm: 'Continuity proof marker WINDOWS_FINAL',
        }));

        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(candidatesListSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
            searchMode: 'fast',
            searchTerm: 'Continuity proof marker WINDOWS_FINAL',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(candidatesListSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
            searchMode: 'full',
            searchTerm: 'Continuity proof marker WINDOWS_FINAL',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(candidatesListSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({
            cursor: 'full-cursor',
            searchMode: 'full',
            searchTerm: 'Continuity proof marker WINDOWS_FINAL',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(hook.getCurrent()).toMatchObject({
            candidates: [
                expect.objectContaining({
                    remoteSessionId: 'deep-match',
                    title: 'Continuity proof marker WINDOWS_FINAL',
                }),
            ],
            error: null,
            loading: false,
            searchIncomplete: false,
        });
    });
});
