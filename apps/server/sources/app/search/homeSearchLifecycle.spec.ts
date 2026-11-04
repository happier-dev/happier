const afterTxCallbacks = vi.hoisted(() => ({ callbacks: [] as Array<() => void> }));
vi.mock('@/storage/inTx', () => ({
    afterTx: (_tx: unknown, callback: () => void) => { afterTxCallbacks.callbacks.push(callback); },
}));

import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    notifySessionTranscriptMutationAfterCommit,
    type SessionTranscriptMutation,
} from '@/app/session/sessionTranscriptMutationObserver';
import { openHomeSearchDb, type HomeSearchDb } from './homeSearchDb';
import { HOME_SEARCH_CATCHUP_DIRTY_IDENTITY_LIMIT, startHomeSearchLifecycle } from './homeSearchLifecycle';
import type { HomeSearchCanonicalMessage } from './homeSearchIndexer';

function reader(readRows: () => readonly HomeSearchCanonicalMessage[]) {
    return async ({ afterId, limit, sessionIds }: { afterId?: string; limit: number; sessionIds: readonly string[] }) => {
        const rows = [...readRows()].filter(row => sessionIds.includes(row.sessionId)).sort((left, right) => left.id.localeCompare(right.id));
        const messages = rows.filter((row) => !afterId || row.id > afterId).slice(0, limit);
        const nextAfterId = messages.length === limit ? messages.at(-1)?.id : undefined;
        return { messages, ...(nextAfterId ? { nextAfterId } : {}) };
    };
}

function corruptOnce(db: HomeSearchDb, operation: 'upsert' | 'search'): HomeSearchDb {
    let pending = true;
    const fail = () => {
        if (!pending) return;
        pending = false;
        const error = new Error('database disk image is malformed') as Error & { code: string };
        error.code = 'SQLITE_CORRUPT';
        throw error;
    };
    return {
        ...db,
        upsert(message) {
            if (operation === 'upsert') fail();
            db.upsert(message);
        },
        upsertMany(messages) {
            if (operation === 'upsert') fail();
            db.upsertMany(messages);
        },
        search(input) {
            if (operation === 'search') fail();
            return db.search(input);
        },
    };
}

function failSearchOnce(db: HomeSearchDb): HomeSearchDb {
    let pending = true;
    return {
        ...db,
        search(input) {
            if (pending) {
                pending = false;
                throw new Error('transient query interruption');
            }
            return db.search(input);
        },
    };
}

function plainTextContent(text: string): HomeSearchCanonicalMessage['content'] {
    return { t: 'plain', v: { role: 'user', content: { type: 'text', text } } };
}

/** Delivers mutations through the canonical post-commit path with the transaction boundary mocked out. */
async function commitMutations(mutations: readonly SessionTranscriptMutation[]): Promise<void> {
    for (const mutation of mutations) {
        notifySessionTranscriptMutationAfterCommit({} as never, mutation);
    }
    for (const callback of afterTxCallbacks.callbacks.splice(0)) callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Home search lifecycle', () => {
    it('keeps search readiness nonthrowing after a cold explicit repair fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-cold-repair-failure-'));
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'search.sqlite'), homeServerIdentityId: 'srv_test', storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => []),
            openDb: async () => { throw new Error('filesystem unavailable'); },
        });
        try {
            await expect(lifecycle.invalidateAndRebuild('explicit-repair')).rejects.toThrow('filesystem unavailable');
            await expect(lifecycle.prepare(['s-1'])).resolves.toBeUndefined();
            expect(lifecycle.search({ v: 1, query: 'phrase', scope: { type: 'global' }, mode: 'auto' }))
                .toMatchObject({ ok: false, errorCode: 'memory_index_missing' });
        } finally { await lifecycle.stop(); }
    });

    it('reuses a cold explicit repair when the first visible scope is subsequently demanded', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-cold-repair-'));
        const openDb = vi.fn(openHomeSearchDb);
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'search.sqlite'), homeServerIdentityId: 'srv_test', storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => [{
                id: 'repair-first', sessionId: 's-1', seq: 1, createdAtMs: 1, content: plainTextContent('cold repair phrase'),
            }]), openDb,
        });
        try {
            await lifecycle.invalidateAndRebuild('explicit-repair');
            await lifecycle.prepare(['s-1']);
            expect(openDb).toHaveBeenCalledTimes(1);
            expect(lifecycle.search({ v: 1, query: 'cold repair', scope: { type: 'global' }, mode: 'auto' }))
                .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-1' })] });
        } finally { await lifecycle.stop(); }
    });

    it('prepares only demanded visible Sessions once and retains earlier Accounts and shared Sessions', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-demand-'));
        const rows: HomeSearchCanonicalMessage[] = ['owned-a', 'shared-b', 'owned-b', 'unused-c'].map((sessionId, index) => ({
            id: `demand-${index}`, sessionId, seq: 1, createdAtMs: index,
            content: plainTextContent('demand searchable phrase'),
        }));
        const pages: string[][] = [];
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async (input) => {
                pages.push([...input.sessionIds]);
                return reader(() => rows.filter(row => input.sessionIds.includes(row.sessionId)))(input);
            },
        });
        try {
            expect(lifecycle.capability()).toEqual({ enabled: true });
            expect(pages).toEqual([]);
            await lifecycle.prepare(['owned-a', 'shared-b']);
            expect(pages).toEqual([['owned-a', 'shared-b']]);
            expect(lifecycle.search({ v: 1, query: 'demand', scope: { type: 'global' }, mode: 'auto' }))
                .toMatchObject({ ok: true, hits: expect.arrayContaining([
                    expect.objectContaining({ sessionId: 'owned-a' }), expect.objectContaining({ sessionId: 'shared-b' }),
                ]) });
            await lifecycle.prepare(['shared-b', 'owned-b']);
            await lifecycle.prepare(['owned-a', 'shared-b']);
            expect(pages).toEqual([['owned-a', 'shared-b'], ['owned-b']]);
            const result = lifecycle.search({ v: 1, query: 'demand', scope: { type: 'global' }, mode: 'auto' });
            expect(result.ok && result.hits.map(hit => 'sessionId' in hit ? hit.sessionId : undefined).sort())
                .toEqual(['owned-a', 'owned-b', 'shared-b']);

            await commitMutations([{ kind: 'upsert', message: {
                id: 'unused-live', sessionId: 'unused-c', seq: 2, createdAtMs: 5,
                content: plainTextContent('unused account live phrase'),
            } }]);
            expect(lifecycle.search({ v: 1, query: 'unused account', scope: { type: 'global' }, mode: 'auto' }))
                .toMatchObject({ ok: true, hits: [] });
            await lifecycle.invalidateAndRebuild('explicit-repair');
            expect(pages.at(-1)).toEqual(['owned-a', 'shared-b', 'owned-b']);
            expect(pages.flat()).not.toContain('unused-c');
        } finally { await lifecycle.stop(); }
    });

    it('reads zero canonical pages and opens no index on an unused Home', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-deferred-'));
        const path = join(root, 'derived', 'search.sqlite');
        const openDb = vi.fn(openHomeSearchDb);
        const readCanonicalMessagesPage = vi.fn(reader(() => []));
        const lifecycle = await startHomeSearchLifecycle({
            dbPath: path,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage,
            openDb,
        });

        expect(openDb).not.toHaveBeenCalled();
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });

        await lifecycle.whenReady();
        expect(readCanonicalMessagesPage).toHaveBeenCalledTimes(0);
        expect(openDb).toHaveBeenCalledTimes(0);
        expect(lifecycle.capability()).toEqual({ enabled: true });
        await lifecycle.stop();
    });

    it('composes reconciliation, readiness gating, search, and shutdown over one index database', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-'));
        let rows: readonly HomeSearchCanonicalMessage[] = [
            { id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 10, role: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'lifecycle probe text' } } } },
        ];
        const lifecycle = await startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => rows),
        });

        // A cold provider accepts demand; the first search route prepares its visible scope.
        expect(lifecycle.capability()).toEqual({ enabled: true });
        expect(lifecycle.search({ v: 1, query: 'lifecycle', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_index_missing' });

        void lifecycle.prepare(['s-1']);
        await lifecycle.whenReady();
        expect(lifecycle.capability()).toEqual({ enabled: true });
        expect(lifecycle.search({ v: 1, query: 'lifecycle', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-1', homeServerIdentityId: 'srv_test' })] });

        await lifecycle.stop();
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
        expect(lifecycle.search({ v: 1, query: 'lifecycle', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_index_missing' });
        await expect(lifecycle.stop()).resolves.toBeUndefined();
    });

    it('never indexes non-plain homes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-e2ee-'));
        const lifecycle = await startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'e2ee',
            readCanonicalMessagesPage: reader(() => [
                { id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 10, content: { type: 'text', text: 'secret words' } },
            ]),
        });
        void lifecycle.prepare(['s-1']);
        await lifecycle.whenReady();
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
        expect(lifecycle.search({ v: 1, query: 'secret', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_disabled' });
        await lifecycle.stop();
    });

    it('degrades to typed unavailability when the index database cannot open', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-degraded-'));
        const lifecycle = await startHomeSearchLifecycle({
            dbPath: root, // A directory cannot be opened as a SQLite database.
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => []),
        });
        expect(lifecycle.capability()).toEqual({ enabled: true });
        void lifecycle.prepare(['empty-canonical-fixture']);
        await lifecycle.whenReady();
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
        expect(lifecycle.search({ v: 1, query: 'x', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_index_missing' });
        await lifecycle.stop();
    });

    it('drops mutations after terminal startup failure and recovers only from canonical reconciliation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-terminal-startup-'));
        const canonicalRows: HomeSearchCanonicalMessage[] = [];
        const appliedMessageIds: string[] = [];
        let identityReads = 0;
        let opens = 0;
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => canonicalRows),
            openDb: async (params) => {
                opens += 1;
                if (opens === 1) throw new Error('terminal startup failure');
                const real = await openHomeSearchDb(params);
                return {
                    ...real,
                    upsert(message) {
                        appliedMessageIds.push(message.id);
                        real.upsert(message);
                    },
                };
            },
        });

        void lifecycle.prepare(['s-stale']);
        await lifecycle.whenReady();
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });

        const staleMessage: HomeSearchCanonicalMessage = {
            get id() {
                identityReads += 1;
                return 'm-stale';
            },
            sessionId: 's-stale',
            seq: 1,
            createdAtMs: 1,
            content: plainTextContent('must not survive terminal failure'),
        };
        await commitMutations([{
            kind: 'upsert',
            message: staleMessage,
        }]);
        expect(identityReads).toBe(0);

        await lifecycle.invalidateAndRebuild('explicit-repair');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(opens).toBe(2);
        expect(appliedMessageIds).toEqual([]);
        expect(lifecycle.capability()).toEqual({ enabled: true });
        expect(lifecycle.search({ v: 1, query: 'must not survive', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [] });
        await lifecycle.stop();
    });

    it('recreates only the derived database after corruption and supports explicit invalidation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-corrupt-'));
        const path = join(root, 'derived', 'search.sqlite');
        await writeFile(path, 'not a sqlite database', { flag: 'w' }).catch(async () => {
            const { mkdir } = await import('node:fs/promises');
            await mkdir(join(root, 'derived'), { recursive: true });
            await writeFile(path, 'not a sqlite database');
        });
        const lifecycle = await startHomeSearchLifecycle({
            dbPath: path,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => [
                { id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, content: { t: 'plain', v: { content: { type: 'text', text: 'rebuilt projection' } } } },
            ]),
        });
        void lifecycle.prepare(['s-1']);
        await lifecycle.whenReady();
        expect(lifecycle.search({ v: 1, query: 'rebuilt', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true });
        await lifecycle.invalidateAndRebuild('restore');
        expect(lifecycle.search({ v: 1, query: 'rebuilt', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true });
        await lifecycle.stop();
    });

    it('reports failure when explicit repair joins an unsuccessful automatic rebuild', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-joined-repair-'));
        let canonicalReads = 0;
        let markRebuildReadStarted!: () => void;
        const rebuildReadStarted = new Promise<void>((resolve) => { markRebuildReadStarted = resolve; });
        let releaseRebuildRead!: () => void;
        const rebuildReadGate = new Promise<void>((resolve) => { releaseRebuildRead = resolve; });
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async () => {
                canonicalReads += 1;
                if (canonicalReads === 1) return { messages: [] };
                markRebuildReadStarted();
                await rebuildReadGate;
                throw new Error('automatic rebuild reconciliation failed');
            },
        });
        void lifecycle.prepare(['empty-canonical-fixture']);
        await lifecycle.whenReady();

        const automatic = lifecycle.invalidateAndRebuild('restore');
        await rebuildReadStarted;
        const explicit = lifecycle.invalidateAndRebuild('explicit-repair');
        releaseRebuildRead();

        await expect(automatic).resolves.toBeUndefined();
        await expect(explicit).rejects.toThrow('did not produce a ready index');
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
        await lifecycle.stop();
    });

    it('reports failure when an explicit repair replacement fails while draining catch-up mutations', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-explicit-catchup-failure-'));
        let canonicalReads = 0;
        let markRepairReadStarted!: () => void;
        const repairReadStarted = new Promise<void>((resolve) => { markRepairReadStarted = resolve; });
        let releaseRepairRead!: () => void;
        const repairReadGate = new Promise<void>((resolve) => { releaseRepairRead = resolve; });
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async () => {
                canonicalReads += 1;
                if (canonicalReads === 1) return { messages: [] };
                markRepairReadStarted();
                await repairReadGate;
                return { messages: [] };
            },
            openDb: async (openParams) => {
                const real = await openHomeSearchDb(openParams);
                return {
                    ...real,
                    upsert() {
                        throw new Error('explicit repair catch-up write failed');
                    },
                };
            },
        });
        void lifecycle.prepare(['s-catch-up']);
        await lifecycle.whenReady();

        const repair = lifecycle.invalidateAndRebuild('explicit-repair');
        await repairReadStarted;
        await commitMutations([{
            kind: 'upsert',
            message: {
                id: 'm-catch-up',
                sessionId: 's-catch-up',
                seq: 1,
                createdAtMs: 1,
                content: plainTextContent('queued during explicit repair'),
            },
        }]);
        releaseRepairRead();

        await expect(repair).rejects.toThrow('did not produce a ready index');
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
        await lifecycle.stop();
    });

    it('rebuilds an unsupported derived schema instead of disabling canonical search', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-schema-upgrade-'));
        const path = join(root, 'derived', 'search.sqlite');
        const { mkdir } = await import('node:fs/promises');
        const { DatabaseSync } = await import('node:sqlite');
        await mkdir(join(root, 'derived'), { recursive: true });
        const stale = new DatabaseSync(path);
        stale.exec(`
            CREATE TABLE home_search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO home_search_meta(key, value) VALUES ('schema_version', '999');
        `);
        stale.close();

        const lifecycle = startHomeSearchLifecycle({
            dbPath: path,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => [
                { id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'schema projection rebuilt' } } } },
            ]),
        });

        void lifecycle.prepare(['s-1']);
        await lifecycle.whenReady();
        expect(lifecycle.capability()).toEqual({ enabled: true });
        expect(lifecycle.search({ v: 1, query: 'schema', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-1' })] });
        await lifecycle.stop();
    });

    it('coalesces corruption during reconciliation into a real derived-index rebuild', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-reconcile-corrupt-'));
        const path = join(root, 'derived', 'search.sqlite');
        let opens = 0;
        const lifecycle = await startHomeSearchLifecycle({
            dbPath: path,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => [
                { id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'recovered projection' } } } },
            ]),
            openDb: async (params) => {
                const db = await openHomeSearchDb(params);
                opens += 1;
                return opens === 1 ? corruptOnce(db, 'upsert') : db;
            },
        });

        void lifecycle.prepare(['s-1']);
        await vi.waitFor(() => expect(lifecycle.capability()).toEqual({ enabled: true }));
        expect(opens).toBe(2);
        expect(lifecycle.search({ v: 1, query: 'recovered', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.anything()] });
        await lifecycle.stop();
    });

    it('returns typed unavailability during query corruption and recovers through the same rebuild owner', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-query-corrupt-'));
        const path = join(root, 'derived', 'search.sqlite');
        let opens = 0;
        const lifecycle = await startHomeSearchLifecycle({
            dbPath: path,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => [
                { id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'query recovery' } } } },
            ]),
            openDb: async (params) => {
                const db = await openHomeSearchDb(params);
                opens += 1;
                return opens === 1 ? corruptOnce(db, 'search') : db;
            },
        });

        void lifecycle.prepare(['s-1']);
        await lifecycle.whenReady();
        expect(lifecycle.search({ v: 1, query: 'query', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_failed' });
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
        await vi.waitFor(() => expect(lifecycle.capability()).toEqual({ enabled: true }));
        expect(opens).toBe(2);
        expect(lifecycle.search({ v: 1, query: 'query', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.anything()] });
        await lifecycle.stop();
    });

    it('keeps the Home provider ready after an ordinary one-off query failure', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-query-transient-'));
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: reader(() => [
                { id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, content: { t: 'plain', v: { content: { type: 'text', text: 'query remains available' } } } },
            ]),
            openDb: async (params) => failSearchOnce(await openHomeSearchDb(params)),
        });

        void lifecycle.prepare(['s-1']);
        await lifecycle.whenReady();
        expect(lifecycle.search({ v: 1, query: 'query', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_failed' });
        expect(lifecycle.capability()).toEqual({ enabled: true });
        expect(lifecycle.search({ v: 1, query: 'query', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true });
        await lifecycle.stop();
    });

    it('bounds startup catch-up: an identity burst past the limit discards the dirty projection and reconciles canonically', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-catchup-overflow-'));
        const burstCount = HOME_SEARCH_CATCHUP_DIRTY_IDENTITY_LIMIT + 25;
        const rows: HomeSearchCanonicalMessage[] = [
            { id: 'm-base', sessionId: 's-1', seq: 0, createdAtMs: 0, content: plainTextContent('baseline anchor text') },
        ];
        for (let i = 0; i < burstCount; i += 1) {
            rows.push({
                id: `m-burst-${String(i).padStart(5, '0')}`,
                sessionId: 's-1',
                seq: i + 1,
                createdAtMs: i + 1,
                content: plainTextContent(`burst message ${i} searchable phrase`),
            });
        }
        let reconcilePasses = 0;
        let releaseFirstPage!: () => void;
        const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
        let firstPageEntered!: () => void;
        const firstPageSignal = new Promise<void>((resolve) => { firstPageEntered = resolve; });
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async (input) => {
                if (!input.afterId) {
                    reconcilePasses += 1;
                    firstPageEntered();
                    await firstPageGate;
                }
                return reader(() => rows)(input);
            },
        });

        void lifecycle.prepare(['s-1']);
        await firstPageSignal;
        // A committed burst of distinct identities larger than the catch-up bound arrives
        // while the startup projection is still reconciling.
        await commitMutations(rows.slice(1, burstCount + 1).map((message) => ({ kind: 'upsert' as const, message })));
        releaseFirstPage();
        await lifecycle.whenReady();

        // Overflow must not retain every event: the coalesced projection is discarded and the
        // existing canonical paged reconciliation re-derives the exact final state.
        expect(reconcilePasses).toBeGreaterThanOrEqual(2);
        expect(lifecycle.capability()).toEqual({ enabled: true });
        expect(lifecycle.search({ v: 1, query: 'baseline anchor', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-1' })] });
        const burst = lifecycle.search({ v: 1, query: 'burst message searchable', scope: { type: 'global' }, mode: 'auto', maxResults: 100 });
        expect(burst.ok).toBe(true);
        if (burst.ok) expect(burst.hits).toHaveLength(100);
        expect(lifecycle.search({ v: 1, query: '1024', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-1' })] });
        await lifecycle.stop();
    });

    it('coalesces a repetitive catch-up burst into final per-identity writes without re-reconciling', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-catchup-coalesce-'));
        const rows: HomeSearchCanonicalMessage[] = [
            { id: 'm-hot', sessionId: 's-1', seq: 1, createdAtMs: 1, content: plainTextContent('coalesced wording v300') },
            { id: 'm-gone', sessionId: 's-1', seq: 2, createdAtMs: 2, content: plainTextContent('gone phrase text') },
            { id: 'm-doomed', sessionId: 's-doomed', seq: 1, createdAtMs: 3, content: plainTextContent('doomed session phrase') },
            { id: 'm-keep', sessionId: 's-1', seq: 3, createdAtMs: 4, content: plainTextContent('survivor phrase stays') },
        ];
        let reconcilePasses = 0;
        let releaseFirstPage!: () => void;
        const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
        let firstPageEntered!: () => void;
        const firstPageSignal = new Promise<void>((resolve) => { firstPageEntered = resolve; });
        const appliedUpserts: Array<Readonly<{ id: string; text: string }>> = [];
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async (input) => {
                if (!input.afterId) {
                    reconcilePasses += 1;
                    firstPageEntered();
                    await firstPageGate;
                }
                return reader(() => rows)(input);
            },
            openDb: async (openParams) => {
                const real = await openHomeSearchDb(openParams);
                return {
                    ...real,
                    upsert(message) {
                        appliedUpserts.push({ id: message.id, text: message.text });
                        real.upsert(message);
                    },
                };
            },
        });

        void lifecycle.prepare(['s-1', 's-doomed']);
        await firstPageSignal;
        const repetitive: SessionTranscriptMutation[] = [];
        for (let version = 1; version <= 300; version += 1) {
            repetitive.push({ kind: 'upsert', message: { id: 'm-hot', sessionId: 's-1', seq: 1, createdAtMs: 1, content: plainTextContent(`coalesced wording v${version}`) } });
        }
        repetitive.push({ kind: 'upsert', message: { id: 'm-gone', sessionId: 's-1', seq: 2, createdAtMs: 2, content: plainTextContent('gone phrase v1') } });
        repetitive.push({ kind: 'upsert', message: { id: 'm-gone', sessionId: 's-1', seq: 2, createdAtMs: 2, content: plainTextContent('gone phrase v2') } });
        repetitive.push({ kind: 'remove-messages', messageIds: ['m-gone'] });
        repetitive.push({ kind: 'remove-session', sessionId: 's-doomed' });
        await commitMutations(repetitive);
        releaseFirstPage();
        await lifecycle.whenReady();

        // Repetitive mutations of one identity coalesce into its final state; the reconciliation
        // runs exactly once and the final FTS rows match the canonical projection.
        expect(reconcilePasses).toBe(1);
        expect(appliedUpserts.filter((entry) => entry.id === 'm-hot')).toEqual([
            { id: 'm-hot', text: 'coalesced wording v300' },
        ]);
        expect(lifecycle.search({ v: 1, query: 'v299', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [] });
        expect(lifecycle.search({ v: 1, query: 'v300', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-1' })] });
        expect(lifecycle.search({ v: 1, query: 'gone', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [] });
        expect(lifecycle.search({ v: 1, query: 'doomed', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [] });
        expect(lifecycle.search({ v: 1, query: 'survivor', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.anything()] });
        expect(lifecycle.capability()).toEqual({ enabled: true });
        await lifecycle.stop();
    });

    it('preserves the last committed order across overlapping message and session identities', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-catchup-order-'));
        const rows: HomeSearchCanonicalMessage[] = [];
        const startupSnapshot: readonly HomeSearchCanonicalMessage[] = [];
        let releaseFirstPage!: () => void;
        const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
        let firstPageEntered!: () => void;
        const firstPageSignal = new Promise<void>((resolve) => { firstPageEntered = resolve; });
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async (input) => {
                if (!input.afterId) {
                    firstPageEntered();
                    await firstPageGate;
                }
                return reader(() => startupSnapshot)(input);
            },
        });

        void lifecycle.prepare(['s-recreated']);
        await firstPageSignal;

        const first = { id: 'm-recreated', sessionId: 's-recreated', seq: 1, createdAtMs: 1, content: plainTextContent('obsolete before deletion') } satisfies HomeSearchCanonicalMessage;
        rows.push(first);
        await commitMutations([{ kind: 'upsert', message: first }]);

        rows.splice(0);
        await commitMutations([{ kind: 'remove-session', sessionId: 's-recreated' }]);

        const recreated = { ...first, updatedAtMs: 2, content: plainTextContent('recreated after session deletion') } satisfies HomeSearchCanonicalMessage;
        rows.push(recreated);
        await commitMutations([{ kind: 'upsert', message: recreated }]);

        releaseFirstPage();
        await lifecycle.whenReady();

        expect(lifecycle.search({ v: 1, query: 'recreated after', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-recreated' })] });
        expect(lifecycle.search({ v: 1, query: 'obsolete before', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [] });
        await lifecycle.stop();
    });

    it('does not become ready until chained mutations committed while catch-up drains are applied', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-catchup-drain-'));
        const canonicalRows: HomeSearchCanonicalMessage[] = [];
        const startupSnapshot: readonly HomeSearchCanonicalMessage[] = [];
        let releaseFirstPage!: () => void;
        const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
        let firstPageEntered!: () => void;
        const firstPageSignal = new Promise<void>((resolve) => { firstPageEntered = resolve; });
        let injectedDuringDrain = false;
        let injectedMutationObserved!: () => void;
        const injectedMutationSignal = new Promise<void>((resolve) => { injectedMutationObserved = resolve; });
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async (input) => {
                if (!input.afterId) {
                    firstPageEntered();
                    await firstPageGate;
                }
                return reader(() => startupSnapshot)(input);
            },
            openDb: async (openParams) => {
                const real = await openHomeSearchDb(openParams);
                return {
                    ...real,
                    upsert(message) {
                        real.upsert(message);
                        if (message.id !== 'm-first' || injectedDuringDrain) return;
                        injectedDuringDrain = true;
                        queueMicrotask(() => {
                            const later = {
                                id: 'm-during-drain',
                                sessionId: 's-drain',
                                seq: 2,
                                createdAtMs: 2,
                                content: plainTextContent('committed while catch up drains'),
                            } satisfies HomeSearchCanonicalMessage;
                            canonicalRows.push(later);
                            notifySessionTranscriptMutationAfterCommit({} as never, { kind: 'upsert', message: later });
                            for (const callback of afterTxCallbacks.callbacks.splice(0)) callback();
                            injectedMutationObserved();
                        });
                    },
                };
            },
        });

        void lifecycle.prepare(['s-drain']);
        await firstPageSignal;
        const first = {
            id: 'm-first',
            sessionId: 's-drain',
            seq: 1,
            createdAtMs: 1,
            content: plainTextContent('initial catch up write'),
        } satisfies HomeSearchCanonicalMessage;
        canonicalRows.push(first);
        await commitMutations([{ kind: 'upsert', message: first }]);
        releaseFirstPage();
        let readyResolved = false;
        const ready = lifecycle.whenReady().then(() => { readyResolved = true; });
        await injectedMutationSignal;

        expect(injectedDuringDrain).toBe(true);
        expect(readyResolved).toBe(false);
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'indexing' });
        expect(lifecycle.search({ v: 1, query: 'while catch up drains', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_index_missing' });
        await ready;
        expect(lifecycle.search({ v: 1, query: 'while catch up drains', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-drain' })] });
        await lifecycle.stop();
    });

    it('does not advertise ready when a later queued catch-up write fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-catchup-failure-'));
        let releaseFirstPage!: () => void;
        const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
        let firstPageEntered!: () => void;
        const firstPageSignal = new Promise<void>((resolve) => { firstPageEntered = resolve; });
        let catchUpWrites = 0;
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async (input) => {
                if (!input.afterId) {
                    firstPageEntered();
                    await firstPageGate;
                }
                return reader(() => [])(input);
            },
            openDb: async (openParams) => {
                const real = await openHomeSearchDb(openParams);
                return {
                    ...real,
                    upsert(message) {
                        catchUpWrites += 1;
                        if (catchUpWrites === 2) throw new Error('later catch-up write failed');
                        real.upsert(message);
                    },
                };
            },
        });

        void lifecycle.prepare(['s-failure']);
        await firstPageSignal;
        await commitMutations([
            { kind: 'upsert', message: { id: 'm-first', sessionId: 's-failure', seq: 1, createdAtMs: 1, content: plainTextContent('first queued write') } },
            { kind: 'upsert', message: { id: 'm-second', sessionId: 's-failure', seq: 2, createdAtMs: 2, content: plainTextContent('second queued write') } },
        ]);
        releaseFirstPage();
        await lifecycle.whenReady();

        expect(catchUpWrites).toBe(2);
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
        expect(lifecycle.search({ v: 1, query: 'first queued', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_index_missing' });

        let identityReads = 0;
        await commitMutations([{
            kind: 'upsert',
            message: {
                get id() {
                    identityReads += 1;
                    return 'm-after-terminal-failure';
                },
                sessionId: 's-failure',
                seq: 3,
                createdAtMs: 3,
                content: plainTextContent('must not be retained after terminal failure'),
            },
        }]);
        expect(identityReads).toBe(0);
        await lifecycle.stop();
    });

    it('bounds catch-up during rebuild the same way and recovers exact state through canonical reconciliation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-rebuild-catchup-'));
        const rows: HomeSearchCanonicalMessage[] = [
            { id: 'm-keep', sessionId: 's-1', seq: 0, createdAtMs: 0, content: plainTextContent('initial anchor phrase') },
        ];
        let armed = false;
        let rebuildPasses = 0;
        let releaseRebuildPage!: () => void;
        const rebuildPageGate = new Promise<void>((resolve) => { releaseRebuildPage = resolve; });
        let rebuildPageEntered!: () => void;
        const rebuildPageSignal = new Promise<void>((resolve) => { rebuildPageEntered = resolve; });
        const lifecycle = startHomeSearchLifecycle({
            dbPath: join(root, 'derived', 'search.sqlite'),
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async (input) => {
                if (armed && !input.afterId) {
                    rebuildPasses += 1;
                    rebuildPageEntered();
                    await rebuildPageGate;
                }
                return reader(() => rows)(input);
            },
        });

        void lifecycle.prepare(['s-1']);
        await lifecycle.whenReady();
        expect(lifecycle.capability()).toEqual({ enabled: true });

        const burstCount = HOME_SEARCH_CATCHUP_DIRTY_IDENTITY_LIMIT + 10;
        for (let i = 0; i < burstCount; i += 1) {
            rows.push({
                id: `m-burst-${String(i).padStart(5, '0')}`,
                sessionId: 's-1',
                seq: i + 1,
                createdAtMs: i + 1,
                content: plainTextContent(`burst message ${i} searchable phrase`),
            });
        }
        armed = true;
        const rebuild = lifecycle.invalidateAndRebuild('restore');
        await rebuildPageSignal;
        await commitMutations(rows.slice(1).map((message) => ({ kind: 'upsert' as const, message })));
        releaseRebuildPage();
        await rebuild;

        expect(rebuildPasses).toBeGreaterThanOrEqual(2);
        expect(lifecycle.capability()).toEqual({ enabled: true });
        expect(lifecycle.search({ v: 1, query: 'initial anchor', scope: { type: 'global' }, mode: 'auto' }))
            .toMatchObject({ ok: true, hits: [expect.anything()] });
        const burst = lifecycle.search({ v: 1, query: 'burst message searchable', scope: { type: 'global' }, mode: 'auto', maxResults: 100 });
        expect(burst.ok).toBe(true);
        if (burst.ok) expect(burst.hits).toHaveLength(100);
        await lifecycle.stop();
    });

    it('stops at the in-flight canonical page instead of finishing the reconstructible startup projection', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-lifecycle-stop-'));
        const dbPath = join(root, 'derived', 'search.sqlite');
        // Three full reconciliation pages plus a remainder, so an unstopped startup projection
        // keeps reading canonical pages after shutdown was requested.
        const rows: readonly HomeSearchCanonicalMessage[] = Array.from({ length: 751 }, (_unused, index) => ({
            id: `m-${String(index).padStart(5, '0')}`,
            sessionId: 's-1',
            seq: index,
            createdAtMs: index,
            content: plainTextContent(`startup page message ${index} searchable phrase`),
        }));
        const readPage = reader(() => rows);
        let pagesRead = 0;
        let firstPageEntered!: () => void;
        const firstPageSignal = new Promise<void>((resolve) => { firstPageEntered = resolve; });
        let releaseFirstPage!: () => void;
        const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
        const lifecycle = startHomeSearchLifecycle({
            dbPath,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: async (input) => {
                pagesRead += 1;
                if (pagesRead === 1) {
                    firstPageEntered();
                    await firstPageGate;
                }
                return await readPage(input);
            },
        });

        void lifecycle.prepare(['s-1']);
        await firstPageSignal;
        const stopping = lifecycle.stop();
        releaseFirstPage();
        await stopping;

        // Shutdown joins only the page already in flight. The derived index is rebuildable, so the
        // remaining canonical pages must never hold the Home's shutdown phase open.
        expect(pagesRead).toBe(1);
        expect(lifecycle.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });

        // The in-flight page completed its writes before SQLite closed, and the partial projection
        // is never advertised as settled: a fresh start re-derives the exact canonical corpus.
        const partial = await openHomeSearchDb({ dbPath });
        expect(partial.count()).toBe(250);
        partial.close();

        const restarted = startHomeSearchLifecycle({
            dbPath,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            readCanonicalMessagesPage: readPage,
        });
        void restarted.prepare(['s-1']);
        await restarted.whenReady();
        expect(restarted.capability()).toEqual({ enabled: true });
        expect(restarted.search({ v: 1, query: 'startup page searchable', scope: { type: 'global' }, mode: 'auto', maxResults: 1 }))
            .toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's-1' })] });
        await restarted.stop();
    });
});
