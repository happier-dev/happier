import { describe, expect, it, vi } from 'vitest';

import { createSharedSubscriptionStore, type SharedSubscriptionWatchOutcome } from './sharedSubscriptionStore';

type TestInput = Readonly<{
    machineId: string;
    serverId?: string | null;
}>;

type TestState = Readonly<{
    value: number;
    refreshes: number;
}>;

type TestSnapshot = Readonly<{ value: number }>;

describe('createSharedSubscriptionStore', () => {
    it('rearms a watch from a direct read when its old watch answers during that read', async () => {
        let finishRead!: (value: number) => void;
        const pending = new Promise<number>(resolve => { finishRead = resolve; });
        let reads = 0;
        const watches: Array<{ cursor: number; resolve(value: SharedSubscriptionWatchOutcome<number>): void }> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            watchAfterRefresh: true,
            defaultSnapshotClient: () => ++reads === 1 ? Promise.resolve(1) : pending,
            defaultWatchClient: (cursor: number) => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => watches.push({ cursor, resolve })),
            refresh: ({ snapshotClient }) => snapshotClient(),
            watch: ({ state, watchClient }) => watchClient(state),
            applySnapshot: (_state: number, snapshot: number) => snapshot,
        });
        const release = store.subscribe('resource', () => {});
        try {
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            const read = store.read('resource');
            watches[0]!.resolve({ status: 'idle' });
            for (let turn = 0; turn < 8; turn++) await Promise.resolve();
            expect(watches).toHaveLength(1);
            finishRead(2);
            await read;
            await vi.waitFor(() => expect(watches).toHaveLength(2));
            expect(watches[1]?.cursor).toBe(2);
        } finally { finishRead(2); release(); store.reset(); }
    });

    it('reconciles a retained read with current publications at commit without another read', async () => {
        let current = 1;
        let held = false;
        let finishRead!: (value: number) => void;
        const pending = new Promise<number>(resolve => { finishRead = resolve; });
        const snapshotClient = vi.fn(() => held ? pending : Promise.resolve(current));
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            retainState: true, defaultSnapshotClient: snapshotClient,
            refresh: async ({ snapshotClient: read }) => {
                const received = await read();
                return (latest: number) => Math.max(latest, received);
            },
            applySnapshot: (_state: number, snapshot: number) => snapshot,
        });
        const observed: number[] = [];
        const release = store.subscribe('session', () => observed.push(store.getState('session')));
        const unrelated = vi.fn();
        const releaseUnrelated = store.observe('other', unrelated);
        try {
            await vi.waitFor(() => expect(store.getState('session')).toBe(1));
            observed.length = 0;
            held = true;
            store.invalidate('session');
            finishRead(1);
            // The read reducer has returned; its subscription commit is still queued.
            await Promise.resolve();
            for (let value = 2; value <= 76; value++) store.publish('session', value);
            current = 76;
            held = false;
            await vi.waitFor(() => expect(store.isRefreshing('session')).toBe(false));
            expect(snapshotClient).toHaveBeenCalledTimes(2);
            expect(store.getState('session')).toBe(76);
            expect(observed).toEqual(Array.from({ length: 75 }, (_, index) => index + 2));
            expect(unrelated).not.toHaveBeenCalled();
        } finally { release(); releaseUnrelated(); store.reset(); }
    });

    it('shares a one-shot acquired read until its last mounted owner retires', async () => {
        const calls: AbortSignal[] = [];
        let finish = () => {};
        const store = createSharedSubscriptionStore({ emptyState: 0, createState: () => 0,
            normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            retainState: true, defaultSnapshotClient: async () => 0,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, next: number) => next });
        const read = (signal: AbortSignal) => {
            calls.push(signal);
            return new Promise<void>(resolve => { finish = resolve; });
        };
        const first = store.acquireReadOnce('machine-a', 'session-a', read);
        const second = store.acquireReadOnce('machine-a', 'session-a', read);
        const reads = [first.readOnce(), second.readOnce()];
        expect(calls).toHaveLength(1);
        first.dispose();
        expect(calls[0]?.aborted).toBe(false);
        finish();
        await Promise.all(reads);
        await second.readOnce();
        expect(calls).toHaveLength(1);
        second.dispose();
        const reopened = store.acquireReadOnce('machine-a', 'session-a', read);
        const pending = reopened.readOnce();
        expect(calls).toHaveLength(2);
        store.reset();
        expect(calls[1]?.aborted).toBe(true);
        finish();
        await pending;
        reopened.dispose();
    });
    it('forgets retained content on owner retirement without deleting another or replacement entry', async () => {
        const retirements: Array<{ key: string; retire(): void; dispose: ReturnType<typeof vi.fn> }> = [];
        let value = 0;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            retainState: true, defaultSnapshotClient: async () => ++value,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            subscribeRetirement: (key: string, retire: () => void) => {
                const dispose = vi.fn();
                retirements.push({ key, retire, dispose });
                return dispose;
            },
        });
        const release = store.subscribe('first', () => {});
        await store.read('first');
        release();
        expect(store.getState('first')).toBe(1);
        await store.read('other');
        try {
            retirements.find(entry => entry.key === 'first')?.retire();
            expect(store.getState('first')).toBe(0);
            expect(store.getState('other')).toBe(2);
            expect(retirements[0]?.dispose).toHaveBeenCalledOnce();
            store.publish('first', 99);
            expect(store.getState('first')).toBe(0);
            const replacement = store.subscribe('first', () => {});
            try {
                await store.read('first');
                expect(store.getState('first')).toBe(3);
                retirements[0]?.retire();
                release();
                expect(store.getState('first')).toBe(3);
                expect(retirements[2]?.dispose).not.toHaveBeenCalled();
            } finally { replacement(); }
        } finally { release(); store.reset(); }
        expect(retirements.every(entry => entry.dispose.mock.calls.length === 1)).toBe(true);
    });

    it.each(['read', 'watch'] as const)('empties active observers and cancels owned %s work on retirement without rewatching', async phase => {
        let retire = () => {};
        const requests: Array<{ signal?: AbortSignal; resolve(value: number): void }> = [];
        const watches: Array<{ signal?: AbortSignal; resolve(value: SharedSubscriptionWatchOutcome<number>): void }> = [];
        const listener = vi.fn();
        const detachRecovery = vi.fn();
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            watchAfterRefresh: true,
            defaultSnapshotClient: (signal?: AbortSignal) => new Promise<number>(resolve => requests.push({ signal, resolve })),
            defaultWatchClient: (signal?: AbortSignal) => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => watches.push({ signal, resolve })),
            beginRefresh: () => -1,
            refresh: ({ snapshotClient, signal }) => snapshotClient(signal),
            watch: ({ watchClient, signal }) => watchClient(signal),
            applySnapshot: (_state: number, snapshot: number) => snapshot,
            subscribeRecovery: () => detachRecovery,
            subscribeRetirement: (_key: string, callback: () => void) => { retire = callback; return () => {}; },
        });
        const release = store.subscribe('resource', listener);
        let releaseReplacement = () => {};
        try {
            if (phase === 'watch') {
                requests[0]!.resolve(7);
                await vi.waitFor(() => expect(watches).toHaveLength(1));
            }
            listener.mockClear();
            retire();
            expect(store.getState('resource')).toBe(0);
            expect(listener).toHaveBeenCalledOnce();
            expect(requests[0]!.signal?.aborted).toBe(phase === 'read');
            expect(detachRecovery).toHaveBeenCalledOnce();
            if (phase === 'watch') expect(watches[0]!.signal?.aborted).toBe(true);
            requests[0]!.resolve(99);
            watches[0]?.resolve({ status: 'changed', snapshot: 99 });
            for (let turn = 0; turn < 8; turn++) await Promise.resolve();
            expect(store.getState('resource')).toBe(0);
            expect(watches).toHaveLength(phase === 'watch' ? 1 : 0);
            releaseReplacement = store.subscribe('resource', () => {});
            release();
            requests[1]!.resolve(8);
            await vi.waitFor(() => expect(store.getState('resource')).toBe(8));
            expect(watches).toHaveLength(phase === 'watch' ? 2 : 1);
        } finally {
            releaseReplacement(); release(); store.reset();
            for (const request of requests) request.resolve(0);
            for (const watch of watches) watch.resolve({ status: 'unavailable' });
        }
    });

    it('refreshes a non-covering publication only while the retained projection is demanded', async () => {
        type Input = Readonly<{ machineId: string; projection: string }>;
        const input: Input = { machineId: 'machine', projection: 'workspace' };
        const broader: Input = { machineId: 'machine', projection: 'all' };
        let value = 0;
        const snapshotClient = vi.fn(async () => ++value);
        const watchSignals: Array<AbortSignal | undefined> = [];
        const watchClient = vi.fn((signal?: AbortSignal) => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => {
            watchSignals.push(signal);
            signal?.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true });
        }));
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: Input) => key,
            storeKey: (key: Input) => `${key.machineId}:${key.projection}`,
            retainState: true, watchAfterRefresh: true,
            defaultSnapshotClient: snapshotClient, defaultWatchClient: watchClient,
            refresh: ({ snapshotClient: client }) => client(),
            watch: ({ watchClient: client, signal }) => client(signal),
            applySnapshot: (_state: number, snapshot: number) => snapshot,
            matchesPublish: (entry, published) => entry.machineId === published.machineId,
            snapshotCoversEntry: (entry, _snapshot, published) => entry.projection === published.projection,
        });
        let release = store.subscribe(input, () => {});
        try {
            await vi.waitFor(() => expect(watchClient).toHaveBeenCalledOnce());
            expect(store.getState(input)).toBe(1);
            release();
            expect(watchSignals[0]?.aborted).toBe(true);
            snapshotClient.mockClear();
            watchClient.mockClear();

            // A sibling Action affects this entry, but carries another projection.
            store.publish(broader, 99);
            await Promise.resolve();
            await Promise.resolve();
            expect(snapshotClient).not.toHaveBeenCalled();
            expect(watchClient).not.toHaveBeenCalled();
            expect(store.getState(input)).toBe(1);

            // A covered answer is already admitted data, not a reason to read.
            store.publish(input, 7);
            expect(store.getState(input)).toBe(7);
            expect(snapshotClient).not.toHaveBeenCalled();
            expect(watchClient).not.toHaveBeenCalled();

            release = store.subscribe(input, () => {});
            expect(store.getState(input)).toBe(7);
            await vi.waitFor(() => expect(store.getState(input)).toBe(2));
            expect(snapshotClient).toHaveBeenCalledOnce();
            expect(watchClient).toHaveBeenCalledOnce();

            store.publish(broader, 99);
            await vi.waitFor(() => expect(store.getState(input)).toBe(3));
            expect(snapshotClient).toHaveBeenCalledTimes(2);
            expect(watchClient).toHaveBeenCalledOnce();
            release();
            expect(watchSignals[1]?.aborted).toBe(true);

            // Explicit read authority remains independent of subscription demand.
            store.invalidate(input);
            expect(snapshotClient).toHaveBeenCalledTimes(2);
            await store.readOnce(input);
            expect(store.getState(input)).toBe(4);
            await store.readOnce(input);
            expect(snapshotClient).toHaveBeenCalledTimes(3);
            await store.read(input);
            expect(store.getState(input)).toBe(5);
            expect(snapshotClient).toHaveBeenCalledTimes(4);
            expect(watchClient).toHaveBeenCalledOnce();
        } finally { release(); store.reset(); }
    });

    it.each(['parked', 'preparing'] as const)('revalidates a reconnected transport without waiting for its %s watch', async phase => {
        let recover: ((revalidate?: boolean) => void) | undefined;
        let reads = 0;
        let watches = 0;
        let finishWatch!: (value: SharedSubscriptionWatchOutcome<number>) => void;
        let watchSignal: AbortSignal | undefined;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            retainState: true, watchAfterRefresh: true,
            defaultSnapshotClient: async () => ++reads, defaultWatchClient: {},
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, value: number) => value,
            subscribeRecovery: (_input: string, listener: () => void) => { recover = listener; return () => {}; },
            watch: ({ signal }) => {
                watches++;
                watchSignal = signal;
                return {
                    dispatched: phase === 'parked' ? Promise.resolve() : new Promise<void>(() => {}),
                    outcome: new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => { finishWatch = resolve; }),
                };
            },
        });
        const release = store.subscribe('machine', () => {});
        try {
            for (let turn = 0; turn < 8; turn++) await Promise.resolve();
            expect(store.getState('machine')).toBe(1);
            recover?.(true);
            for (let turn = 0; turn < 8; turn++) await Promise.resolve();
            expect(store.getState('machine')).toBe(2);
            expect(reads).toBe(2);
            // The explicit reconnect read does not replay or replace the held watch.
            expect(watchSignal?.aborted).toBe(false);
            finishWatch({ status: 'unavailable' });
            for (let turn = 0; turn < 8; turn++) await Promise.resolve();
            expect(watches).toBe(2);
            expect(reads).toBe(2);
        } finally {
            release(); store.reset(); finishWatch({ status: 'unavailable' });
        }
    });

    it('reports shared revalidation separately while retaining the unchanged data snapshot', async () => {
        let finish!: (value: number) => void;
        let reads = 0;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => { reads++; return await new Promise<number>(resolve => { finish = resolve; }); },
            retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
        });
        const first = store.read('summary');
        finish(7);
        await first;
        const dataUpdates = vi.fn();
        const release = store.observe('summary', dataUpdates);
        const phases: boolean[] = [];
        const releasePhase = store.observeRefreshing('summary', () => phases.push(store.isRefreshing('summary')));
        const refresh = store.read('summary');
        const sibling = store.read('summary');
        try {
            expect(store.isRefreshing('summary')).toBe(true);
            expect(store.getState('summary')).toBe(7);
            expect(dataUpdates).not.toHaveBeenCalled();
            expect(reads).toBe(2);
            finish(7);
            await Promise.all([refresh, sibling]);
            expect(store.isRefreshing('summary')).toBe(false);
            expect(dataUpdates).not.toHaveBeenCalled();
            expect(phases).toEqual([true, false]);
        } finally { finish(7); releasePhase(); release(); store.reset(); }
    });
    it('revalidates returning pull-only demand after its cancelled read settles', async () => {
        const requests: Array<{ resolve: (value: number) => void; signal?: AbortSignal }> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            retainState: true,
            defaultSnapshotClient: (signal?: AbortSignal) => new Promise<number>(resolve => requests.push({ resolve, signal })),
            refresh: ({ snapshotClient, signal }) => snapshotClient(signal), applySnapshot: (_state: number, value: number) => value,
        });
        const first = store.read('summary');
        requests[0]!.resolve(7);
        await first;
        const release = store.subscribe('summary', () => {});
        release();
        expect(requests[1]!.signal?.aborted).toBe(true);
        expect(store.isRefreshing('summary')).toBe(false);
        const returning = store.subscribe('summary', () => {});
        try {
            expect(store.getState('summary')).toBe(7);
            requests[1]!.resolve(99);
            await vi.waitFor(() => expect(requests).toHaveLength(3));
            expect(store.getState('summary')).toBe(7);
            expect(store.isRefreshing('summary')).toBe(true);
            requests[2]!.resolve(8);
            await vi.waitFor(() => expect(store.getState('summary')).toBe(8));
            expect(store.isRefreshing('summary')).toBe(false);
        } finally { returning(); store.reset(); for (const request of requests) request.resolve(7); }
    });
    it.each(['settled', 'in-flight'] as const)('recovers a failed initial snapshot on the existing recovery signal (%s)', async phase => {
        let recover: (() => void) | undefined;
        let finishInitial!: (value: number) => void;
        let available = false;
        const replies: Array<(value: SharedSubscriptionWatchOutcome<number>) => void> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => available ? 1 : await new Promise<number>(resolve => { finishInitial = resolve; }),
            defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            shouldWatch: state => state > 0,
            subscribeRecovery: (_input: string, listener: () => void) => { recover = listener; return () => {}; },
            watch: () => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => replies.push(resolve)),
        });
        const release = store.subscribe('machine', () => {});
        try {
            expect(replies).toHaveLength(0);
            if (phase === 'in-flight') {
                available = true;
                recover?.();
                finishInitial(-1);
            } else {
                finishInitial(-1);
                await vi.waitFor(() => expect(store.getState('machine')).toBe(-1));
                available = true;
                recover?.();
            }
            await vi.waitFor(() => expect(store.getState('machine')).toBe(1));
            expect(replies).toHaveLength(1);
            replies[0]!({ status: 'changed', snapshot: 2 });
            await vi.waitFor(() => expect(store.getState('machine')).toBe(2));
        } finally { release(); store.reset(); }
    });

    it('recovers retired observation only on a demanded recovery event and releases its listener', async () => {
        let recover: (() => void) | undefined;
        const detach = vi.fn();
        const replies: Array<(value: SharedSubscriptionWatchOutcome<number>) => void> = [];
        let reads = 0;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => ++reads, defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            subscribeRecovery: (_input: string, listener: () => void) => { recover = listener; return detach; },
            watch: () => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => replies.push(resolve)),
        });
        const release = store.subscribe('machine', () => {});
        const releaseSibling = store.subscribe('machine', () => {});
        await vi.waitFor(() => expect(replies).toHaveLength(1));
        store.publish('machine', 9);
        expect(detach).not.toHaveBeenCalled();
        recover?.();
        expect(reads).toBe(1);
        replies[0]!({ status: 'idle' });
        await vi.waitFor(() => expect(replies).toHaveLength(2));
        replies[1]!({ status: 'unavailable' });
        await Promise.resolve();
        await Promise.resolve();
        expect(replies).toHaveLength(2);
        recover?.();
        await vi.waitFor(() => expect(replies).toHaveLength(3));
        expect(store.getState('machine')).toBe(2);
        release();
        expect(detach).not.toHaveBeenCalled();
        releaseSibling();
        expect(detach).toHaveBeenCalledOnce();
        recover?.();
        expect(reads).toBe(2);
        store.reset();
    });

    it('keeps a recovery wake when the old watch subsequently makes the retained state unwatchable', async () => {
        let recover: (() => void) | undefined;
        let value = 1;
        const replies: Array<(value: SharedSubscriptionWatchOutcome<number>) => void> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => value, defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            shouldWatch: state => state > 0,
            subscribeRecovery: (_input: string, listener: () => void) => { recover = listener; return () => {}; },
            watch: () => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => replies.push(resolve)),
        });
        const release = store.subscribe('machine', () => {});
        try {
            await vi.waitFor(() => expect(replies).toHaveLength(1));
            value = 2;
            recover?.();
            replies[0]!({ status: 'changed', snapshot: -1 });
            await vi.waitFor(() => expect(store.getState('machine')).toBe(2));
            expect(replies).toHaveLength(2);
        } finally { release(); store.reset(); }
    });

    it('rearms a retired watch when a retained entry gains demand again', async () => {
        let reads = 0;
        const watches: Array<AbortSignal | undefined> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => ++reads, defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            watch: async ({ signal }) => {
                watches.push(signal);
                return watches.length === 1 ? { status: 'unavailable' as const }
                    : new Promise<SharedSubscriptionWatchOutcome<number>>(() => {});
            },
        });
        const release = store.subscribe('machine', () => {});
        await vi.waitFor(() => expect(watches).toHaveLength(1));
        release();
        const resumed = store.subscribe('machine', () => {});
        try {
            await vi.waitFor(() => expect(store.getState('machine')).toBe(2));
            expect(watches).toHaveLength(2);
            expect(watches[1]?.aborted).toBe(false);
        } finally { resumed(); store.reset(); }
    });

    it('reads again when invalidation lands during a read, retaining the last snapshot until the follow-up settles', async () => {
        const reads: Array<(value: number) => void> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: () => new Promise<number>(resolve => reads.push(resolve)),
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
        });
        const unsubscribe = store.subscribe('machine', () => {});
        store.invalidate('machine');
        store.invalidate('machine');
        reads[0]!(1);
        await vi.waitFor(() => expect(reads).toHaveLength(2));
        expect(store.getState('machine')).toBe(1);
        reads[1]!(2);
        await vi.waitFor(() => expect(store.getState('machine')).toBe(2));
        unsubscribe();
    });

    it('keeps watching when an invalidation overtakes an unavailable watch reply', async () => {
        const replies: Array<(value: SharedSubscriptionWatchOutcome<number>) => void> = [];
        let value = 1;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => value, defaultWatchClient: {}, watchAfterRefresh: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            watch: () => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => replies.push(resolve)),
        });
        const unsubscribe = store.subscribe('machine', () => {});
        await vi.waitFor(() => expect(replies).toHaveLength(1));
        value = 2;
        store.invalidate('machine');
        replies[0]!({ status: 'unavailable' });
        await vi.waitFor(() => expect(replies).toHaveLength(2));
        expect(store.getState('machine')).toBe(2);
        unsubscribe();
    });
    it.each(['unavailable', 'rejection', 'changed', 'idle', 'retry'] as const)('restores publication freshness while an old watch finishes with %s', async outcome => {
        const pending: Array<{ signal?: AbortSignal; resolve(value: SharedSubscriptionWatchOutcome<number>): void; reject(error: unknown): void }> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (input: string) => input, storeKey: (input: string) => input,
            defaultSnapshotClient: async () => 1, defaultWatchClient: {}, watchAfterRefresh: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            // The parked network reply is the boundary; store lifecycle remains real.
            watch: ({ signal }) => new Promise<SharedSubscriptionWatchOutcome<number>>((resolve, reject) => pending.push({ signal, resolve, reject })),
        });
        const unsubscribe = store.subscribe('a', () => {});
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        store.publish('a', 2);
        expect(pending).toHaveLength(1);
        expect(pending[0]!.signal?.aborted).toBe(false);
        if (outcome === 'rejection') pending[0]!.reject(new Error('offline'));
        else pending[0]!.resolve(outcome === 'changed' ? { status: 'changed', snapshot: 3 } : { status: outcome });
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        expect(store.getState('a')).toBe(outcome === 'changed' ? 3 : 2);
        pending[1]!.resolve({ status: 'changed', snapshot: 4 });
        await vi.waitFor(() => expect(store.getState('a')).toBe(4));
        unsubscribe();
        expect(pending.at(-1)?.signal?.aborted).toBe(true);
        store.reset();
    });

    it('restores an already retired watch on publication and ignores late answers after disposal', async () => {
        let calls = 0;
        let finish!: (value: SharedSubscriptionWatchOutcome<number>) => void;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (input: string) => input, storeKey: (input: string) => input,
            defaultSnapshotClient: async () => 1, defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            watch: async () => ++calls === 1 ? { status: 'unavailable' as const }
                : new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => { finish = resolve; }),
        });
        const unsubscribe = store.subscribe('a', () => {});
        await vi.waitFor(() => expect(calls).toBe(1));
        store.publish('a', 2);
        await vi.waitFor(() => expect(calls).toBe(2));
        unsubscribe();
        finish({ status: 'changed', snapshot: 0 });
        await Promise.resolve();
        expect(store.getState('a')).toBe(2);
        expect(calls).toBe(2);
        store.reset();
    });
    it('keeps a retained snapshot after demand ends and shares a one-shot read without opening a watch', async () => {
        const snapshotClient = vi.fn(async () => 7);
        const watchClient = vi.fn(async () => ({ status: 'unavailable' as const }));
        const store = createSharedSubscriptionStore({
            emptyState: 0,
            createState: () => 0,
            normalizeInput: (input: string) => input,
            storeKey: (input: string) => input,
            defaultSnapshotClient: snapshotClient,
            defaultWatchClient: watchClient,
            retainState: true,
            refresh: async ({ snapshotClient: client }) => client(),
            applySnapshot: (_state: number, snapshot: number) => snapshot,
            watch: async ({ watchClient: client }) => client(),
        });
        const unsubscribe = store.subscribe('machine-a', () => {});
        await store.read('machine-a');
        unsubscribe();
        expect(store.getState('machine-a')).toBe(7);
        snapshotClient.mockClear();
        watchClient.mockClear();
        await Promise.all([store.read('machine-a'), store.read('machine-a')]);
        expect(snapshotClient).toHaveBeenCalledOnce();
        expect(watchClient).not.toHaveBeenCalled();
        expect(store.getState('machine-a')).toBe(7);
    });
    it('centralizes keyed subscribe, refresh, publish, and cleanup behavior', async () => {
        const snapshotClient = vi.fn(async () => ({ ok: true as const, snapshot: { value: 7 } }));
        const store = createSharedSubscriptionStore<
            TestInput,
            TestState,
            TestSnapshot,
            typeof snapshotClient
        >({
            emptyState: { value: 0, refreshes: 0 },
            createState: () => ({ value: 0, refreshes: 0 }),
            normalizeInput: (input) => ({ machineId: input.machineId, serverId: input.serverId ?? null }),
            storeKey: (input) => `${input.serverId ?? ''}::${input.machineId}`,
            defaultSnapshotClient: snapshotClient,
            refresh: async ({ state, snapshotClient: client }) => {
                const result = await client();
                return result.ok
                    ? { value: result.snapshot.value, refreshes: state.refreshes + 1 }
                    : { ...state, refreshes: state.refreshes + 1 };
            },
            applySnapshot: (state, snapshot) => ({ ...state, value: snapshot.value }),
        });
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const listener = vi.fn();

        const unsubscribeA = store.subscribe(key, listener, { snapshotClient });
        const unsubscribeB = store.subscribe(key, () => {}, { snapshotClient });
        await Promise.resolve();
        await Promise.resolve();

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(store.getState(key)).toEqual({ value: 7, refreshes: 1 });

        listener.mockClear();
        store.publish(key, { value: 11 });

        expect(listener).toHaveBeenCalledOnce();
        expect(store.getState(key)).toEqual({ value: 11, refreshes: 1 });

        unsubscribeA();
        unsubscribeB();
        expect(store.getState(key)).toEqual({ value: 0, refreshes: 0 });
    });
});
