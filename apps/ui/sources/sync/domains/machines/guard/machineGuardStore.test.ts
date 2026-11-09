import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { createMachineGuardViewFixture } from './guardViewFixtures';
import { createMachineGuardStore } from './machineGuardStore';
import type { MachineGuardClients, MachineGuardResult } from './machineGuardRpc';
import type { MachineGuardWatchResultV1, MachineGuardActivityWatchResultV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const idleActivityWatch: MachineGuardClients['activityWatchClient'] = async () => new Promise(() => {});

describe('Guard last-good freshness', () => {
    it('retains typed read failures for Guard and Activity and clears them on recovery', async () => {
        const failure = { ok: false as const, reason: 'request_failed' as const, errorCode: 'permission_denied' };
        let recovered = false;
        const store = createMachineGuardStore({
            viewClient: async () => recovered ? { ok: true, value: createMachineGuardViewFixture() } : failure,
            watchClient: async () => new Promise(() => {}),
            activityClient: async () => recovered ? { ok: true, value: { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1 } } : failure,
            activityWatchClient: idleActivityWatch,
        });
        const key = { machineId: 'machine', serverId: 'home', expectedAccountId: 'owner', range: '7d' as const, filter: 'all' as const };
        const releases = [store.demandView(key), store.demandActivity(key)];
        try {
            await settle();
            expect(store.getView(key)).toMatchObject({ status: 'error', failure });
            expect(store.getActivity(key)).toMatchObject({ status: 'error', failure });
            recovered = true;
            store.retryView(key); store.retryActivity(key);
            await settle();
            expect(store.getView(key)).toMatchObject({ status: 'ready' });
            expect(store.getActivity(key)).toMatchObject({ status: 'ready' });
            expect(store.getView(key)).not.toHaveProperty('failure');
            expect(store.getActivity(key)).not.toHaveProperty('failure');
        } finally { releases.forEach(release => release()); store.reset(); }
    });

    it('retains unchanged Guard rows by identity while a real changed fact advances the view', async () => {
        const watches: Array<ReturnType<typeof createDeferred<MachineGuardResult<MachineGuardWatchResultV1>>>> = [];
        const view = createMachineGuardViewFixture({ idle: ['first', 'second'].map(sessionRef => ({
            sessionRef, title: sessionRef, agentId: 'codex', status: 'not_yet', idleMs: 1000,
        })) });
        const store = createMachineGuardStore({
            viewClient: async () => ({ ok: true, value: structuredClone(view) }),
            watchClient: () => {
                const reply = createDeferred<MachineGuardResult<MachineGuardWatchResultV1>>();
                watches.push(reply); return reply.promise;
            },
            activityClient: async () => ({ ok: false, reason: 'request_failed' }), activityWatchClient: idleActivityWatch,
        });
        const key = { machineId: 'machine', serverId: 'home', expectedAccountId: 'owner' };
        const release = store.demandView(key);
        try {
            await settle();
            const held = store.getView(key).view!;
            const changed = structuredClone(view);
            changed.idle[0] = { ...changed.idle[0]!, status: 'stops_at', stopAt: 3000 };
            changed.idle.reverse();
            watches[0]!.resolve({ ok: true, value: { changed: true, since: 2, view: changed } });
            await settle();
            const current = store.getView(key).view!;
            expect(current.idle[0]).toBe(held.idle[1]);
            expect(current.idle[1]).toMatchObject({ sessionRef: 'first', status: 'stops_at', stopAt: 3000 });
            expect(current.policy).toBe(held.policy);
            expect(current.ladder).toBe(held.ladder);
        } finally { release(); store.reset(); }
    });

    it('retains equal Activity publications and preserves rows by id through a changed watch answer', async () => {
        const watches: Array<ReturnType<typeof createDeferred<MachineGuardResult<MachineGuardActivityWatchResultV1>>>> = [];
        const entries: ReturnType<typeof createMachineGuardViewFixture>['recentActivity'] = ['first', 'second'].map(id => ({
            v: 1, id, at: 1, kind: 'closed_browser', rule: 'memory_guard', outcome: 'done', attribution: { kind: 'unknown' },
        }));
        const list = { entries, counts: { stopped: 2, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1234 };
        const store = createMachineGuardStore({
            viewClient: async () => ({ ok: true, value: createMachineGuardViewFixture() }),
            watchClient: async () => new Promise(() => {}),
            activityClient: async () => ({ ok: true, value: structuredClone(list) }),
            activityWatchClient: () => {
                const reply = createDeferred<MachineGuardResult<MachineGuardActivityWatchResultV1>>();
                watches.push(reply); return reply.promise;
            },
        });
        const key = { machineId: 'machine', serverId: 'home', expectedAccountId: 'owner', range: '7d' as const, filter: 'all' as const };
        const release = store.demandActivity(key);
        let stop = () => {};
        try {
            await settle();
            // Establish the daemon cursor before measuring content publications.
            watches.at(-1)!.resolve({ ok: true, value: { changed: true, since: 1, list: structuredClone(list) } });
            await settle();
            const held = store.getActivity(key);
            const publications = vi.fn();
            stop = store.observeActivity(key, publications);
            for (let index = 0; index < 3; index++) {
                watches.at(-1)!.resolve({ ok: true, value: { changed: true, since: 1, list: structuredClone(list) } });
                await settle();
            }
            expect(publications).not.toHaveBeenCalled();
            expect(store.getActivity(key)).toBe(held);
            const changed = structuredClone(list);
            changed.entries[0] = { ...changed.entries[0]!, undoneAt: 2000 };
            changed.entries.reverse();
            watches.at(-1)!.resolve({ ok: true, value: { changed: true, since: 2, list: changed } });
            await settle();
            expect(publications).toHaveBeenCalledTimes(1);
            expect(store.getActivity(key).list?.entries[0]).toBe(held.list?.entries[1]);
            expect(store.getActivity(key).list?.entries[1]).toMatchObject({ id: 'first', undoneAt: 2000 });
        } finally { stop(); release(); store.reset(); }
    });

    it('keeps Activity-only demand fresh without any Guard read or watch', async () => {
        const viewClient = vi.fn(async () => ({ ok: true as const, value: createMachineGuardViewFixture() }));
        const watchClient = vi.fn(async () => new Promise<MachineGuardResult<MachineGuardWatchResultV1>>(() => {}));
        const reply = createDeferred<MachineGuardResult<MachineGuardActivityWatchResultV1>>();
        const activityWatchClient = vi.fn<MachineGuardClients['activityWatchClient']>().mockImplementationOnce(() => reply.promise)
            .mockImplementation(() => new Promise(() => {}));
        const list = { entries: [] as [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1234 };
        const store = createMachineGuardStore({ viewClient, watchClient, activityWatchClient,
            activityClient: async () => ({ ok: true as const, value: list }) });
        const key = { machineId: 'machine', serverId: null, expectedAccountId: null, range: '7d' as const, filter: 'all' as const };
        const release = store.demandActivity(key);
        try {
            await settle();
            expect(viewClient).not.toHaveBeenCalled();
            expect(watchClient).not.toHaveBeenCalled();
            expect(activityWatchClient).toHaveBeenCalledTimes(1);
            reply.resolve({ ok: true, value: { changed: true, since: 1, list: { ...list, asOf: 2000 } } });
            await settle();
            expect(store.getActivity(key).list?.asOf).toBe(2000);
        } finally { release(); store.reset(); }
    });

    it('refreshes demanded ranges and filters when an earlier-day Undo leaves Today unchanged', async () => {
        const watches: Array<{ input: Parameters<MachineGuardClients['activityWatchClient']>[0]; reply: ReturnType<typeof createDeferred<MachineGuardResult<MachineGuardActivityWatchResultV1>>> }> = [];
        const yesterday = Date.UTC(2026, 9, 19, 12);
        let asOf = Date.UTC(2026, 9, 20, 12);
        let entries: ReturnType<typeof createMachineGuardViewFixture>['recentActivity'] = [{
            v: 1, id: 'yesterday', at: yesterday, kind: 'stopped_session', rule: 'idle_sessions', outcome: 'done',
            attribution: { kind: 'unknown' },
            wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 'session' } }],
        }];
        const store = createMachineGuardStore({
            viewClient: async () => ({ ok: true, value: createMachineGuardViewFixture() }),
            watchClient: async () => new Promise(() => {}),
            activityWatchClient: input => {
                const reply = createDeferred<MachineGuardResult<MachineGuardActivityWatchResultV1>>();
                watches.push({ input, reply }); return reply.promise;
            },
            activityClient: async () => ({ ok: true, value: {
                entries, counts: { stopped: entries.length, cleanedUp: 0, needsLook: 0, others: 0 }, asOf,
            } }),
        });
        const key = { machineId: 'machine', serverId: 'home', expectedAccountId: 'owner', range: '7d' as const, filter: 'all' as const };
        const filtered = { ...key, range: '30d' as const, filter: 'stopped' as const };
        const releaseView = store.demandView(key);
        const release = store.demandActivity(key);
        const releaseFiltered = store.demandActivity(filtered);
        try {
            await settle();
            expect(store.getActivity(key).list?.entries[0]?.wayBack).toHaveLength(1);
            expect(watches).toHaveLength(2);
            asOf += 1;
            entries = entries.map(({ wayBack: _wayBack, ...entry }) => ({ ...entry, undoneAt: asOf }));
            for (const watch of [...watches]) watch.reply.resolve({ ok: true, value: { changed: true, since: 2,
                list: { entries, counts: { stopped: entries.length, cleanedUp: 0, needsLook: 0, others: 0 }, asOf } } });
            await settle();
            expect(store.getActivity(key).list?.entries).toEqual(entries);
            expect(store.getActivity(filtered).list?.entries).toEqual(entries);
            release(); releaseFiltered();
            const retained = store.getActivity(key).list;
            asOf += 1;
            watches.at(-1)!.reply.resolve({ ok: true, value: { changed: true, since: 3,
                list: { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf } } });
            await settle();
            expect(store.getActivity(key).list).toBe(retained);
            expect(store.getActivity(filtered).list?.asOf).toBe(asOf - 1);
        } finally { release(); releaseFiltered(); releaseView(); store.reset(); }
    });

    it('shares one Activity query watch until the final release and preserves its cursor', async () => {
        const watches: Array<{ signal?: AbortSignal; since?: number; reply: ReturnType<typeof createDeferred<MachineGuardResult<MachineGuardActivityWatchResultV1>>> }> = [];
        let entries: ReturnType<typeof createMachineGuardViewFixture>['recentActivity'] = [];
        const store = createMachineGuardStore({
            viewClient: async () => ({ ok: true, value: createMachineGuardViewFixture() }),
            watchClient: async () => new Promise(() => {}),
            activityWatchClient: input => {
                const reply = createDeferred<MachineGuardResult<MachineGuardActivityWatchResultV1>>();
                watches.push({ signal: input.signal, since: input.since, reply });
                return reply.promise;
            },
            activityClient: async () => ({ ok: true, value: { entries, counts: { stopped: entries.length, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 2000 } }),
        });
        const firstKey = { machineId: 'machine', serverId: null, expectedAccountId: null, range: '7d' as const, filter: 'all' as const };
        const secondKey = { ...firstKey };
        const first = store.demandActivity(firstKey);
        const second = store.demandActivity(secondKey);
        try {
            await settle();
            expect(watches).toHaveLength(1);
            const append = async (id: string) => {
                entries = [{ v: 1, id, at: 2000, kind: 'closed_browser', rule: 'memory_guard', outcome: 'done', attribution: { kind: 'unknown' } }, ...entries];
                watches.at(-1)!.reply.resolve({ ok: true, value: { changed: true, since: entries.length,
                    list: { entries, counts: { stopped: entries.length, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 2000 } } });
                await settle();
            };
            await append('first');
            expect(store.getActivity(firstKey).list?.entries).toEqual(entries);
            expect(store.getActivity(secondKey).list?.entries).toEqual(entries);
            expect(watches.at(-1)!.since).toBe(1);
            first(); first();
            expect(watches.at(-1)!.signal?.aborted).toBe(false);
            await append('second');
            expect(store.getActivity(secondKey).list?.entries).toEqual(entries);
            second();
            expect(watches.at(-1)!.signal?.aborted).toBe(true);
        } finally { first(); second(); store.reset(); }
    });

    it('rearms a changed Guard watch without invalidating the independent Activity query', async () => {
        const watches: Array<ReturnType<typeof createDeferred<MachineGuardResult<MachineGuardWatchResultV1>>>> = [];
        const order: string[] = [];
        let changed = false;
        const store = createMachineGuardStore({
            viewClient: async () => ({ ok: true, value: createMachineGuardViewFixture() }),
            watchClient: () => {
                order.push('watch');
                const reply = createDeferred<MachineGuardResult<MachineGuardWatchResultV1>>();
                watches.push(reply); return reply.promise;
            },
            activityClient: async () => {
                if (changed) order.push('activity');
                return { ok: true, value: { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1 } };
            },
            activityWatchClient: idleActivityWatch,
        });
        const key = { machineId: 'machine', serverId: null, expectedAccountId: null, range: '7d' as const, filter: 'all' as const };
        const unobserve = store.observeView(key, () => { if (changed) order.push('view'); });
        const releaseView = store.demandView(key);
        const releaseActivity = store.demandActivity(key);
        try {
            await settle(); order.length = 0; changed = true;
            watches[0]!.resolve({ ok: true, value: { changed: true, since: 2, view: createMachineGuardViewFixture({
                recentActivity: [{ v: 1, id: 'append', at: 1, kind: 'closed_browser', rule: 'memory_guard', outcome: 'done', attribution: { kind: 'unknown' } }],
            }) } });
            await settle();
            expect(order).toEqual(['watch', 'view']);
            expect(store.getView(key).since).toBe(2);
        } finally { releaseActivity(); releaseView(); unobserve(); store.reset(); }
    });

    it('refreshes Activity after one of two consumers releases the same query', async () => {
        let asOf = 1000;
        const store = createMachineGuardStore({
            viewClient: async () => ({ ok: true, value: createMachineGuardViewFixture() }),
            watchClient: async () => new Promise(() => {}),
            activityWatchClient: idleActivityWatch,
            activityClient: async () => ({ ok: true, value: { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf } }),
        });
        const key = { machineId: 'machine', serverId: 'home', expectedAccountId: 'owner', range: '7d' as const, filter: 'all' as const };
        const first = store.demandActivity(key);
        const second = store.demandActivity(key);
        try {
            await settle(); second(); asOf = 2000;
            store.refreshMachine(key); await settle();
            expect(store.getActivity(key).list?.asOf).toBe(2000);
        } finally { first(); store.reset(); }
    });

    it('marks retained Activity checking on refresh without renewing its asOf on failure', async () => {
        const reply = createDeferred<MachineGuardResult<{ entries: []; counts: { stopped: number; cleanedUp: number; needsLook: number; others: number }; asOf: number }>>();
        let reads = 0;
        const store = createMachineGuardStore({
            viewClient: async () => ({ ok: true, value: createMachineGuardViewFixture() }),
            watchClient: async () => new Promise(() => {}),
            activityWatchClient: idleActivityWatch,
            activityClient: async () => ++reads === 1
                ? { ok: true, value: { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1234 } }
                : reply.promise,
        });
        const key = { machineId: 'machine', serverId: 'home', expectedAccountId: 'owner', range: '7d' as const, filter: 'all' as const };
        const release = store.demandActivity(key);
        try {
            await settle();
            const list = store.getActivity(key).list;
            store.retryActivity(key);
            expect(store.getActivity(key)).toMatchObject({ status: 'loading', list });
            reply.resolve({ ok: false, reason: 'request_failed' });
            await settle();
            expect(store.getActivity(key)).toMatchObject({ status: 'error', list: { asOf: 1234 } });
        } finally { release(); store.reset(); }
    });

    it('retains a ready view during a held refresh without renewing its freshness', async () => {
        const replies: Array<ReturnType<typeof createDeferred<MachineGuardResult<ReturnType<typeof createMachineGuardViewFixture>>>>> = [];
        const watches: Array<ReturnType<typeof createDeferred<MachineGuardResult<MachineGuardWatchResultV1>>>> = [];
        const store = createMachineGuardStore({
            viewClient: async () => {
                const reply = createDeferred<MachineGuardResult<ReturnType<typeof createMachineGuardViewFixture>>>();
                replies.push(reply);
                return reply.promise;
            },
            watchClient: async () => {
                const reply = createDeferred<MachineGuardResult<MachineGuardWatchResultV1>>();
                watches.push(reply); return reply.promise;
            },
            activityClient: async () => ({ ok: false, reason: 'request_failed' }),
            activityWatchClient: idleActivityWatch,
        });
        const key = { machineId: 'machine', serverId: 'home', expectedAccountId: 'owner' };
        const release = store.demandView(key);
        try {
            expect(store.getView(key)).toMatchObject({ status: 'loading', pending: true, view: null, receivedAtMs: null });
            replies[0]!.resolve({ ok: true, value: createMachineGuardViewFixture() });
            await settle();
            const last = store.getView(key);
            store.retryView(key);
            expect(store.getView(key)).toMatchObject({ status: 'ready', pending: true, view: last.view, receivedAtMs: last.receivedAtMs });
            watches[0]!.resolve({ ok: true, value: { changed: true, since: 2, view: createMachineGuardViewFixture({ policyRevision: 2 }) } });
            await settle();
            expect(store.getView(key)).toMatchObject({ pending: true, view: { policyRevision: 2 } });
            const watched = store.getView(key);
            replies[1]!.resolve({ ok: false, reason: 'request_failed' });
            await settle();
            expect(store.getView(key)).toMatchObject({ status: 'error', pending: false, view: watched.view, receivedAtMs: watched.receivedAtMs });
        } finally { release(); store.reset(); }
    });

    it('records when a read or changed watch arrives and retains that time after failures, release and Account changes', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
        const watches: Array<ReturnType<typeof createDeferred<MachineGuardResult<MachineGuardWatchResultV1>>>> = [];
        const key = { machineId: 'machine', serverId: 'home', expectedAccountId: 'owner' };
        const clients: MachineGuardClients = {
            viewClient: async () => ({ ok: true, value: createMachineGuardViewFixture() }),
            watchClient(input) {
                const response = createDeferred<MachineGuardResult<MachineGuardWatchResultV1>>();
                watches.push(response);
                input.signal?.addEventListener('abort', () => response.resolve({ ok: false, reason: 'request_failed' }), { once: true });
                return response.promise;
            },
            activityClient: async () => ({ ok: false, reason: 'request_failed' }),
            activityWatchClient: idleActivityWatch,
        };
        const store = createMachineGuardStore(clients);
        let release = () => {};
        try {
            expect(store.getView(key)).toMatchObject({ view: null, receivedAtMs: null });
            release = store.demandView(key); await settle();
            expect(store.getView(key)).toMatchObject({ status: 'ready', receivedAtMs: 1000 });
            clock.mockReturnValue(2000);
            watches[0]!.resolve({ ok: true, value: { changed: true, since: 2, view: createMachineGuardViewFixture({ policyRevision: 2 }) } });
            await settle();
            expect(store.getView(key)).toMatchObject({ receivedAtMs: 2000, view: { policyRevision: 2 } });
            clock.mockReturnValue(2500);
            watches[1]!.resolve({ ok: true, value: { changed: false } }); await settle();
            expect(store.getView(key)).toMatchObject({ receivedAtMs: 2000 });
            clock.mockReturnValue(3000);
            watches[2]!.resolve({ ok: false, reason: 'request_failed' }); await settle();
            expect(store.getView(key)).toMatchObject({ status: 'error', receivedAtMs: 2000, view: { policyRevision: 2 } });
            release();
            expect(store.getView(key)).toMatchObject({ receivedAtMs: 2000 });
            expect(store.getView({ ...key, expectedAccountId: 'other' })).toMatchObject({ view: null, receivedAtMs: null });
        } finally { release(); store.reset(); clock.mockRestore(); }
    });
});
