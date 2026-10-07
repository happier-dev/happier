import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { openHomeSearchDb } from './homeSearchDb';
import { registerHomeSearchRoutes } from './homeSearchRoutes';
import { createHomeSearchService } from './homeSearchService';
import { startHomeSearchLifecycle } from './homeSearchLifecycle';
import type { HomeSearchCanonicalMessage } from './homeSearchIndexer';

function canonicalReader(readRows: () => readonly HomeSearchCanonicalMessage[]) {
    return async ({ afterId, limit }: { afterId?: string; limit: number }) => {
        const rows = [...readRows()].sort((left, right) => left.id.localeCompare(right.id));
        const messages = rows.filter((row) => !afterId || row.id > afterId).slice(0, limit);
        const nextAfterId = messages.length === limit ? messages.at(-1)?.id : undefined;
        return { messages, ...(nextAfterId ? { nextAfterId } : {}) };
    };
}

describe('Home search route', () => {
    it('requires an ordinary present-user credential and passes only that account visibility to search', async () => {
        const search = vi.fn((_query: unknown, context?: Readonly<{ visibleSessions?: readonly Readonly<{ sessionId: string; maximumSeq: number | null }>[] }>) => ({
            v: 1 as const,
            ok: true as const,
            hits: context?.visibleSessions?.some((session) => session.sessionId === 'owned-session')
                ? [{ sessionId: 'owned-session', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, summary: 'owned', score: 1 }]
                : [],
        }));
        await withAuthenticatedTestApp((app) => registerHomeSearchRoutes(app, {
            service: { capability: () => ({ enabled: true }), search, invalidateAndRebuild: vi.fn() },
            resolveVisibleSessions: async (userId) => userId === 'owner'
                ? [{ sessionId: 'owned-session', maximumSeq: null }]
                : [],
            env: { HAPPIER_FEATURE_SEARCH__ENABLED: '1' },
        }), async (app) => {
            const body = {
                v: 1,
                query: 'owned',
                scope: { type: 'global' },
                mode: 'auto',
                eligibleSessionIds: ['owned-session'],
            };
            expect((await app.inject({ method: 'POST', url: '/v1/home/search', payload: body })).statusCode).toBe(401);
            expect((await app.inject({
                method: 'POST', url: '/v1/home/search', payload: body,
                headers: { 'x-test-user-id': 'owner', 'x-test-auth-token-kind': 'account_directory' },
            })).statusCode).toBe(403);
            expect((await app.inject({
                method: 'POST', url: '/v1/home/search', payload: body,
                headers: { 'x-test-user-id': 'owner', 'x-test-auth-token-kind': 'terminal' },
            })).statusCode).toBe(403);
            const other = await app.inject({ method: 'POST', url: '/v1/home/search', payload: body, headers: { 'x-test-user-id': 'other' } });
            expect(other.json()).toMatchObject({ ok: true, hits: [] });
            const owner = await app.inject({ method: 'POST', url: '/v1/home/search', payload: body, headers: { 'x-test-user-id': 'owner' } });
            expect(owner.json()).toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 'owned-session' })] });
            expect(search).toHaveBeenLastCalledWith(
                expect.objectContaining({ eligibleSessionIds: ['owned-session'] }),
                { visibleSessions: [{ sessionId: 'owned-session', maximumSeq: null }] },
            );
        });
    });

    it('does not expose the route when the canonical search feature is disabled', async () => {
        const search = vi.fn(() => ({ v: 1 as const, ok: true as const, hits: [] }));
        await withAuthenticatedTestApp((app) => registerHomeSearchRoutes(app, {
            service: { capability: () => ({ enabled: true }), search, invalidateAndRebuild: vi.fn() },
            resolveVisibleSessions: async () => [],
            env: {
                HAPPIER_FEATURE_SEARCH__ENABLED: '0',
                HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home',
            },
        }), async (app) => {
            const response = await app.inject({
                method: 'POST',
                url: '/v1/home/search',
                payload: { v: 1, query: 'hidden', scope: { type: 'global' }, mode: 'auto' },
                headers: { 'x-test-user-id': 'owner' },
            });
            expect(response.statusCode).toBe(404);
            expect(search).not.toHaveBeenCalled();
            expect((await app.inject({
                method: 'POST',
                url: '/v1/home/search/rebuild',
                headers: { 'x-test-user-id': 'owner' },
            })).statusCode).toBe(404);
        });
    });

    it('enforces canonical per-Session publication ceilings before returning ranked snippets', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-search-route-publication-'));
        const index = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        index.upsert({ id: 'published', sessionId: 'shared', seq: 4, createdAtMs: 1, text: 'needle ordinary' });
        index.upsert({ id: 'private', sessionId: 'shared', seq: 5, createdAtMs: 2, text: 'needle needle needle' });
        const service = createHomeSearchService({
            db: index,
            homeServerIdentityId: 'srv-home',
            storagePolicy: 'plaintext_only',
        });

        try {
            await withAuthenticatedTestApp((app) => registerHomeSearchRoutes(app, {
                service: { ...service, invalidateAndRebuild: vi.fn() },
                resolveVisibleSessions: async () => [{ sessionId: 'shared', maximumSeq: 4 }],
                env: { HAPPIER_FEATURE_SEARCH__ENABLED: '1' },
            }), async (app) => {
                const response = await app.inject({
                    method: 'POST',
                    url: '/v1/home/search',
                    payload: { v: 1, query: 'needle', scope: { type: 'global' }, mode: 'auto', maxResults: 1 },
                    headers: { 'x-test-user-id': 'reader' },
                });
                expect(response.json()).toMatchObject({
                    ok: true,
                    hits: [expect.objectContaining({ sessionId: 'shared', seqFrom: 4, seqTo: 4 })],
                });
            });
        } finally {
            index.close();
        }
    });

    it('rebuilds the derived index from canonical Home transcript rows through the authenticated repair operation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-search-route-repair-'));
        let canonicalRows: readonly HomeSearchCanonicalMessage[] = [{
            id: 'before-repair',
            sessionId: 'owned-session',
            seq: 1,
            createdAtMs: 1,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'before repair' } } },
        }];
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'search.sqlite'),
            homeServerIdentityId: 'srv-home',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: canonicalReader(() => canonicalRows),
        });
        lifecycle.start();
        await lifecycle.whenReady();

        try {
            await withAuthenticatedTestApp((app) => registerHomeSearchRoutes(app, {
                service: lifecycle,
                resolveVisibleSessions: async () => [{ sessionId: 'owned-session', maximumSeq: null }],
                env: { HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home' },
            }), async (app) => {
                canonicalRows = [{
                    id: 'after-repair',
                    sessionId: 'owned-session',
                    seq: 2,
                    createdAtMs: 2,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'after repair' } } },
                }];

                expect((await app.inject({ method: 'POST', url: '/v1/home/search/rebuild' })).statusCode).toBe(401);
                const rebuilt = await app.inject({
                    method: 'POST',
                    url: '/v1/home/search/rebuild',
                    headers: { 'x-test-user-id': 'owner' },
                });
                expect(rebuilt.statusCode).toBe(200);
                expect(rebuilt.json()).toEqual({ ok: true });

                const result = lifecycle.search(
                    { v: 1, query: 'after repair', scope: { type: 'global' }, mode: 'auto' },
                    { visibleSessions: [{ sessionId: 'owned-session', maximumSeq: null }] },
                );
                expect(result).toMatchObject({
                    ok: true,
                    hits: [expect.objectContaining({ sessionId: 'owned-session', seqFrom: 2, seqTo: 2 })],
                });
                expect(lifecycle.search(
                    { v: 1, query: 'before repair', scope: { type: 'global' }, mode: 'auto' },
                    { visibleSessions: [{ sessionId: 'owned-session', maximumSeq: null }] },
                )).toMatchObject({ ok: true, hits: [] });
            });
        } finally {
            await lifecycle.stop();
        }
    });

    it('surfaces an actual lifecycle repair failure instead of reporting a completed rebuild', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-search-route-repair-failure-'));
        let opens = 0;
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'search.sqlite'),
            homeServerIdentityId: 'srv-home',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: canonicalReader(() => []),
            openDb: async (params) => {
                opens += 1;
                if (opens === 2) throw new Error('rebuild failed');
                return openHomeSearchDb(params);
            },
        });
        lifecycle.start();
        await lifecycle.whenReady();

        try {
            await withAuthenticatedTestApp((app) => registerHomeSearchRoutes(app, {
                service: lifecycle,
                resolveVisibleSessions: async () => [],
                env: { HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home' },
            }), async (app) => {
                const response = await app.inject({
                    method: 'POST',
                    url: '/v1/home/search/rebuild',
                    headers: { 'x-test-user-id': 'owner' },
                });
                expect(response.statusCode).toBe(500);
                expect(opens).toBe(2);
                expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
            });
        } finally {
            await lifecycle.stop();
        }
    });

    it('surfaces canonical reconciliation failure from an explicit repair', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-search-route-reconcile-failure-'));
        let failCanonicalRead = false;
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'search.sqlite'),
            homeServerIdentityId: 'srv-home',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async () => {
                if (failCanonicalRead) throw new Error('canonical reconciliation failed');
                return { messages: [] };
            },
        });
        lifecycle.start();
        await lifecycle.whenReady();
        failCanonicalRead = true;

        try {
            await withAuthenticatedTestApp((app) => registerHomeSearchRoutes(app, {
                service: lifecycle,
                resolveVisibleSessions: async () => [],
                env: { HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home' },
            }), async (app) => {
                const response = await app.inject({
                    method: 'POST',
                    url: '/v1/home/search/rebuild',
                    headers: { 'x-test-user-id': 'owner' },
                });
                expect(response.statusCode).toBe(500);
                expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
            });
        } finally {
            await lifecycle.stop();
        }
    });

    it('does not expose Personal Home repair on a hosted deployment', async () => {
        const invalidateAndRebuild = vi.fn(async () => {});
        await withAuthenticatedTestApp((app) => registerHomeSearchRoutes(app, {
            service: {
                capability: () => ({ enabled: true }),
                search: () => ({ v: 1, ok: true, hits: [] }),
                invalidateAndRebuild,
            },
            resolveVisibleSessions: async () => [],
            env: {},
        }), async (app) => {
            const response = await app.inject({
                method: 'POST',
                url: '/v1/home/search/rebuild',
                headers: { 'x-test-user-id': 'owner' },
            });
            expect(response.statusCode).toBe(404);
            expect(invalidateAndRebuild).not.toHaveBeenCalled();
        });
    });
});
