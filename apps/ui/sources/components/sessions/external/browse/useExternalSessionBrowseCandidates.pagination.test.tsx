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

type CandidateFixture = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    details?: Record<string, unknown>;
    candidateKey?: string;
    linkData?: Readonly<Record<string, unknown>>;
    linkedSessionId?: string;
    imported?: boolean;
    materializedThrough?: number;
}>;

function page(
    candidates: readonly CandidateFixture[],
    nextCursor: string | null,
) {
    return { ok: true, candidates, nextCursor } as const;
}

function preparationPage(
    scanned: number,
    total?: number,
    candidates: readonly CandidateFixture[] = [],
) {
    return {
        ok: true,
        candidates,
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

    it('paginates with the search mode that produced an opaque cursor', async () => {
        const fullRootPage = createDeferred<ReturnType<typeof page> & Readonly<{
            searchIncomplete: true;
        }>>();
        candidatesListSpy
            .mockResolvedValueOnce({
                ...page([
                    { remoteSessionId: 'fast-result', title: 'Fast result', updatedAtMs: 1 },
                ], 'shared-cursor'),
                searchIncomplete: true,
            })
            .mockImplementationOnce(() => fullRootPage.promise)
            .mockResolvedValueOnce({
                ...page([
                    { remoteSessionId: 'fast-page-two', title: 'Fast page two', updatedAtMs: 3 },
                ], 'fast-cursor-two'),
                searchIncomplete: true,
            })
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'full-page-two', title: 'Full page two', updatedAtMs: 4 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates({
            ...params,
            searchTerm: 'result',
        }));

        expect(hook.getCurrent().nextCursor).toBe('shared-cursor');
        const fastPaginationRequestKey = hook.getCurrent().paginationRequestKey;

        await act(async () => {
            await hook.getCurrent().loadMore();
        });

        expect(candidatesListSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({
            cursor: 'shared-cursor',
            searchMode: 'fast',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(hook.getCurrent().nextCursor).toBe('fast-cursor-two');

        fullRootPage.resolve({
            ...page([
                { remoteSessionId: 'full-result', title: 'Full result', updatedAtMs: 2 },
            ], 'shared-cursor'),
            searchIncomplete: true,
        });
        await flushHookEffects();

        expect(hook.getCurrent().nextCursor).toBe('shared-cursor');
        expect(hook.getCurrent().paginationRequestKey).not.toBe(fastPaginationRequestKey);

        await act(async () => {
            await hook.getCurrent().loadMore();
        });

        expect(candidatesListSpy).toHaveBeenNthCalledWith(4, expect.objectContaining({
            cursor: 'shared-cursor',
            searchMode: 'full',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'fast-result',
            'fast-page-two',
            'full-result',
            'full-page-two',
        ]);
    });

    it('replaces a completed full-search preview with its canonical page order', async () => {
        candidatesListSpy
            .mockResolvedValueOnce({
                ...page([
                    { remoteSessionId: 'preview-older', title: 'Preview older', updatedAtMs: 1 },
                ], 'fast-cursor'),
                searchIncomplete: true,
            })
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'full-newest', title: 'Full newest', updatedAtMs: 3 },
                { remoteSessionId: 'preview-older', title: 'Preview older', updatedAtMs: 1 },
            ], 'full-cursor'));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates({
            ...params,
            searchTerm: 'preview',
        }));

        await flushHookEffects();

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'full-newest',
            'preview-older',
        ]);
        expect(hook.getCurrent().nextCursor).toBe('full-cursor');
        expect(hook.getCurrent().searchIncomplete).toBe(false);
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

    it('rebuilds from the root once when the daemon resets a dead continuation', async () => {
        candidatesListSpy
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'one', title: 'One', updatedAtMs: 1 },
            ], 'cursor-1'))
            .mockResolvedValueOnce({
                ok: true,
                candidates: [],
                nextCursor: null,
                cursorReset: true,
            })
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'one', title: 'One', updatedAtMs: 1 },
                { remoteSessionId: 'two', title: 'Two', updatedAtMs: 2 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await act(async () => {
            await hook.getCurrent().loadMore();
        });
        await flushHookEffects();

        // The reset is not a failure: no error is surfaced, the rejected
        // continuation is gone, and the root rebuild republished the listing.
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().nextCursor).toBeNull();
        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId))
            .toEqual(['one', 'two']);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(true);
        // Exactly one rebuild: the dead cursor is never sent again.
        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(candidatesListSpy.mock.calls[2]?.[0]).not.toHaveProperty('cursor');
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

    it('surfaces when the daemon could not confirm every candidate annotation', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ...page([{
                remoteSessionId: 'one',
                updatedAtMs: 1,
            }], null),
            annotationsIncomplete: true,
        });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await flushHookEffects();

        expect(hook.getCurrent().annotationsIncomplete).toBe(true);
        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({ remoteSessionId: 'one' }),
        ]);
    });

    it('retains annotation uncertainty while an appended page preserves earlier rows', async () => {
        candidatesListSpy
            .mockResolvedValueOnce({
                ...page([{
                    remoteSessionId: 'one',
                    updatedAtMs: 1,
                }], 'cursor-1'),
                annotationsIncomplete: true,
            })
            .mockResolvedValueOnce(page([{
                remoteSessionId: 'two',
                updatedAtMs: 2,
            }], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await act(async () => {
            await hook.getCurrent().loadMore();
        });

        expect(hook.getCurrent().annotationsIncomplete).toBe(true);
        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['one', 'two']);
    });

    it('clears annotation uncertainty when a root replacement confirms the visible rows', async () => {
        candidatesListSpy
            .mockResolvedValueOnce({
                ...page([{
                    remoteSessionId: 'one',
                    updatedAtMs: 1,
                }], null),
                annotationsIncomplete: true,
            })
            .mockResolvedValueOnce(page([{
                remoteSessionId: 'one',
                updatedAtMs: 2,
            }], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(hook.getCurrent().annotationsIncomplete).toBe(true);

        await act(async () => {
            await hook.getCurrent().reload();
        });

        expect(hook.getCurrent().annotationsIncomplete).toBe(false);
        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({ remoteSessionId: 'one', updatedAtMs: 2 }),
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
            ], 'old-cursor'));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(
            (hookParams: typeof params) => useExternalSessionBrowseCandidates(hookParams),
            { initialProps: params },
        );
        const firstScopePaginationRequestKey = hook.getCurrent().paginationRequestKey;

        await act(async () => {
            void hook.getCurrent().loadMore();
        });
        expect(hook.getCurrent().loadingMore).toBe(true);

        await hook.rerender({ ...params, machineId: 'machine-2' });

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['new-root']);
        expect(hook.getCurrent().nextCursor).toBe('old-cursor');
        expect(hook.getCurrent().paginationRequestKey).not.toBe(firstScopePaginationRequestKey);
        expect(hook.getCurrent().loadingMore).toBe(false);

        stalePage.resolve(page([
            { remoteSessionId: 'stale-page', title: 'Stale page', updatedAtMs: 3 },
        ], null));
        await flushHookEffects();

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['new-root']);
    });

    it.each([
        ['machine', { ...params, machineId: null }],
        ['Agent', { ...params, providerId: null }],
        ['source', { ...params, source: null }],
    ] as const)('aborts and clears a valid scope when its %s selection becomes invalid', async (_scopeKind, invalidParams) => {
        const stalePage = createDeferred<ReturnType<typeof page>>();
        let staleSignal: AbortSignal | undefined;
        candidatesListSpy
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'loaded-result', title: 'Loaded result', updatedAtMs: 1 },
            ], 'stale-cursor'))
            .mockImplementationOnce((_request, options: Readonly<{ signal?: AbortSignal }>) => {
                staleSignal = options.signal;
                return stalePage.promise;
            });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        type NullableBrowseParams = {
            machineId: string | null;
            providerId: typeof params.providerId | null;
            source: typeof params.source | null;
        };
        const initialParams: NullableBrowseParams = params;
        const hook = await renderHook(
            (hookParams: NullableBrowseParams) => useExternalSessionBrowseCandidates(hookParams),
            { initialProps: initialParams },
        );

        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({ remoteSessionId: 'loaded-result' }),
        ]);
        await act(async () => {
            void hook.getCurrent().loadMore();
        });
        expect(hook.getCurrent().loadingMore).toBe(true);
        expect(staleSignal?.aborted).toBe(false);

        await hook.rerender(invalidParams);

        expect(staleSignal?.aborted).toBe(true);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [],
            nextCursor: null,
            loading: false,
            loadingMore: false,
            searchAugmenting: false,
            searchIncomplete: false,
            preparation: null,
            autoLinkPolicyScope: null,
            error: null,
        });

        stalePage.resolve(page([
            { remoteSessionId: 'stale-result', title: 'Stale result', updatedAtMs: 1 },
        ], null));
        await flushHookEffects();

        expect(hook.getCurrent().candidates).toEqual([]);
        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
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

    it('renders the candidates a preparing index has already served', async () => {
        /**
         * A preparing index serves stored identity rows, never hydrated ones, so a
         * partial row carries no title until the completed generation supplies it.
         */
        const servedRows: readonly CandidateFixture[] = [
            { remoteSessionId: 'partial-one', updatedAtMs: 2 },
            { remoteSessionId: 'partial-two', updatedAtMs: 1 },
        ];
        const nextChunk = createDeferred<ReturnType<typeof preparationPage>>();
        const completedPage = createDeferred<ReturnType<typeof page>>();
        candidatesListSpy
            .mockResolvedValueOnce(preparationPage(50, 100, servedRows))
            .mockImplementationOnce(() => nextChunk.promise)
            .mockImplementationOnce(() => completedPage.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(hook.getCurrent()).toMatchObject({
            candidates: [
                expect.objectContaining({ remoteSessionId: 'partial-one', title: undefined }),
                expect.objectContaining({ remoteSessionId: 'partial-two' }),
            ],
            loading: true,
            error: null,
            preparation: { kind: 'building_candidate_index', scanned: 50, total: 100 },
        });

        const servedCandidates = hook.getCurrent().candidates;
        nextChunk.resolve(preparationPage(120, 200, servedRows.map((row) => ({ ...row }))));
        await flushHookEffects();

        expect(hook.getCurrent().preparation).toMatchObject({ scanned: 120, total: 200 });
        expect(hook.getCurrent().candidates).toBe(servedCandidates);

        completedPage.resolve(page([
            { remoteSessionId: 'complete-one', title: 'Complete one', updatedAtMs: 3 },
        ], null));
        await flushHookEffects();

        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'complete-one' })],
            loading: false,
            preparation: null,
        });
    });

    it('stops a stalled cold index while keeping the candidates it already served actionable and marked incomplete', async () => {
        const servedRows: readonly CandidateFixture[] = [
            { remoteSessionId: 'served', updatedAtMs: 4 },
        ];
        candidatesListSpy
            .mockResolvedValueOnce(preparationPage(50, 100, servedRows))
            .mockResolvedValueOnce(preparationPage(50, 100, servedRows))
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'must-not-publish', updatedAtMs: 9 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'served' })],
            candidatesAuthoritative: true,
            preparationStopped: true,
            loading: false,
            preparation: null,
            nextCursor: null,
            error: null,
        });
    });

    it('stops at the cold-index request cap while keeping the candidates it already served actionable and marked incomplete', async () => {
        const servedRows: readonly CandidateFixture[] = [
            { remoteSessionId: 'served', updatedAtMs: 4 },
        ];
        let scanned = 0;
        candidatesListSpy.mockImplementation(() => {
            scanned += 10;
            return Promise.resolve(preparationPage(scanned, 1_000_000, servedRows));
        });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(250);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'served' })],
            candidatesAuthoritative: true,
            preparationStopped: true,
            loading: false,
            preparation: null,
            error: null,
        });
    });

    it('clears the authority of rows a superseded generation served when preparation restarts', async () => {
        const servedRows: readonly CandidateFixture[] = [
            { remoteSessionId: 'superseded', updatedAtMs: 4 },
        ];
        const restartedChunk = createDeferred<ReturnType<typeof preparationPage>>();
        candidatesListSpy
            .mockResolvedValue(page([
                { remoteSessionId: 'restarted', updatedAtMs: 6 },
            ], null))
            .mockResolvedValueOnce(preparationPage(50, 100, servedRows))
            .mockResolvedValueOnce(preparationPage(10, 100))
            .mockImplementationOnce(() => restartedChunk.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'superseded' })],
            candidatesAuthoritative: false,
            preparationStopped: false,
            loading: true,
            preparation: { kind: 'building_candidate_index', scanned: 10, total: 100 },
            error: null,
        });

        restartedChunk.resolve(preparationPage(40, 100, [
            { remoteSessionId: 'restarted', updatedAtMs: 6 },
        ]));
        await flushHookEffects();

        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'restarted' })],
            candidatesAuthoritative: true,
        });
    });

    it('fails a restarted index that then stalls instead of presenting superseded rows as its result', async () => {
        const servedRows: readonly CandidateFixture[] = [
            { remoteSessionId: 'superseded', updatedAtMs: 4 },
        ];
        candidatesListSpy
            .mockResolvedValueOnce(preparationPage(50, 100, servedRows))
            .mockResolvedValueOnce(preparationPage(10, 100))
            .mockResolvedValueOnce(preparationPage(10, 100))
            .mockResolvedValueOnce(page([
                { remoteSessionId: 'must-not-publish', updatedAtMs: 9 },
            ], null));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [],
            candidatesAuthoritative: false,
            preparationStopped: false,
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

    it('cancels cold-index continuation while retaining served current-generation candidates as stopped and allows retry', async () => {
        const nextChunk = createDeferred<ReturnType<typeof preparationPage>>();
        const observedSignals: AbortSignal[] = [];
        candidatesListSpy
            .mockImplementationOnce((_request, opts: Readonly<{ signal?: AbortSignal }>) => {
                if (opts.signal) observedSignals.push(opts.signal);
                return Promise.resolve(preparationPage(50, 100, [{
                    remoteSessionId: 'served-before-cancel',
                    title: 'Served before cancel',
                    updatedAtMs: 3,
                }]));
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
            candidates: [expect.objectContaining({ remoteSessionId: 'served-before-cancel' })],
            candidatesAuthoritative: true,
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
            candidates: [expect.objectContaining({ remoteSessionId: 'served-before-cancel' })],
            candidatesAuthoritative: true,
            preparationStopped: true,
            loading: false,
            preparation: null,
            error: 'externalSessions.browseIndexingCancelled',
            cancelled: true,
        });

        nextChunk.resolve(preparationPage(100, 100));
        await flushHookEffects();
        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().candidates).toEqual([
            expect.objectContaining({ remoteSessionId: 'served-before-cancel' }),
        ]);

        await act(async () => {
            await hook.getCurrent().reload();
        });
        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'recovered' })],
            error: null,
            cancelled: false,
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

    it('keeps the rows a full-search index already served when its continuation fails', async () => {
        candidatesListSpy
            .mockResolvedValueOnce({
                ...page([{ remoteSessionId: 'fast-hit', title: 'Fast hit', updatedAtMs: 5 }], null),
                searchIncomplete: true,
            })
            .mockResolvedValueOnce(preparationPage(40, 100, [
                { remoteSessionId: 'served-by-full-search', updatedAtMs: 4 },
            ]))
            .mockRejectedValueOnce(new Error('full search continuation failed'));
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates({
            ...params,
            searchTerm: 'deep result',
        }));

        expect(candidatesListSpy).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent()).toMatchObject({
            candidates: [expect.objectContaining({ remoteSessionId: 'served-by-full-search' })],
            candidatesAuthoritative: true,
            preparationStopped: true,
            preparation: null,
            loading: false,
            searchAugmenting: false,
        });
        expect(hook.getCurrent().error).not.toBeNull();
    });

    it('bounds automatic empty full-search continuation at twenty pages', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ...page([], 'fast-cursor'),
            searchIncomplete: true,
        });
        for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
            candidatesListSpy.mockResolvedValueOnce({
                ...page([], `full-cursor-${pageNumber}`),
                searchIncomplete: true,
            });
        }
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates({
            ...params,
            searchTerm: 'deep result',
        }));

        expect(candidatesListSpy).toHaveBeenCalledTimes(21);
        expect(candidatesListSpy).toHaveBeenNthCalledWith(21, expect.objectContaining({
            cursor: 'full-cursor-19',
            limit: 50,
            searchMode: 'full',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(hook.getCurrent()).toMatchObject({
            candidates: [],
            nextCursor: 'full-cursor-20',
            loading: false,
            searchAugmenting: false,
            searchIncomplete: true,
        });
    });
});
