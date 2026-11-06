import { describe, expect, it, vi } from 'vitest';

import { createScopedBatchResolutionSingleFlight } from './scopedResolutionSingleFlight';
import { createDeferred } from '@/dev/testkit';

describe('scoped batch pending reads', () => {
    it('keeps Account-owned physical work joinable after the last borrower leaves, until owner retirement', async () => {
        const owner = new AbortController();
        const caller = new AbortController();
        const reads = createScopedBatchResolutionSingleFlight<string>({ ownerSignal: owner.signal });
        const started = createDeferred<void>();
        const response = createDeferred<ReadonlyMap<string, string>>();
        let physical: AbortSignal | undefined;
        let requests = 0;
        const request = async (_ids: readonly string[], signal: AbortSignal) => {
            requests++;
            physical = signal;
            started.resolve();
            return response.promise;
        };
        const first = reads.run('accounting', ['a'], request, { signal: caller.signal });
        const left = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        try {
            await started.promise;
            caller.abort();
            await left;
            expect(physical?.aborted).toBe(false);
            const second = reads.run('accounting', ['a'], request);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(requests).toBe(1);
            owner.abort();
            expect(physical?.aborted).toBe(true);
            response.resolve(new Map([['a', 'A']]));
            await expect(second).rejects.toMatchObject({ name: 'AbortError' });
        } finally { owner.abort(); response.resolve(new Map([['a', 'A']])); await first.catch(() => {}); }
    });

    it('closes materialization for each physical chunk before the same borrower receives later chunks', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>({ materializePhysicalChunks: true });
        const later = createDeferred<void>();
        const published: string[][] = [];
        const destination = vi.fn((rows: readonly string[]) => { published.push([...rows]); });
        const publications: Promise<void>[] = [];
        const preparation = reads.reserve('details');
        const result = preparation.run(['a', 'b'], async (_ids, _signal, publish) => {
            publish(new Map([['a', 'A']]));
            await later.promise;
            publish(new Map([['b', 'B']]));
            return new Map([['a', 'A'], ['b', 'B']]);
        }, undefined, (_id, value, chunk) => {
            if (!chunk) throw new Error('Expected physical completion context');
            publications.push(chunk.publish(destination, Promise.resolve(value), destination));
        });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(published).toEqual([['A']]);
            later.resolve();
            await result;
            await Promise.all(publications);
            expect(published).toEqual([['A'], ['B']]);
        } finally { later.resolve(); await result; }
    });

    it('closes a physical delivery when another overlapping borrower is cancelled during delivery', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>({ materializePhysicalChunks: true });
        const cancelled = new AbortController();
        const destination = vi.fn((_rows: readonly string[]) => {});
        const publications: Promise<void>[] = [];
        const first = reads.reserve('details');
        const second = reads.reserve('details', { signal: cancelled.signal });
        const request = vi.fn(async () => new Map([['a', 'A']]));
        const survivor = first.run(['a'], request, undefined, (_id, value, chunk) => {
            if (!chunk) throw new Error('Expected physical completion context');
            publications.push(chunk.publish(destination, Promise.resolve(value), destination));
            cancelled.abort();
        });
        const departed = second.run(['a'], request).catch((error: unknown) => error);
        await survivor;
        expect(await departed).toMatchObject({ name: 'AbortError' });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(destination).toHaveBeenCalledExactlyOnceWith(['A']);
        await Promise.all(publications);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])('keeps cancellation work linear with a surviving borrower (settled chunk: %s)', async settledChunk => {
        async function cancellationWork(size: number): Promise<number> {
            const reads = createScopedBatchResolutionSingleFlight<string>();
            const caller = new AbortController();
            const started = createDeferred<void>();
            const response = createDeferred<ReadonlyMap<string, string>>();
            const ids = Array.from({ length: size }, (_, index) => `row-${index}`);
            let physical!: AbortSignal;
            let publish!: (values: ReadonlyMap<string, string>) => void;
            const request = (_ids: readonly string[], signal: AbortSignal, onChunk: typeof publish) => {
                physical = signal;
                publish = onChunk;
                started.resolve();
                return response.promise;
            };
            const departing = reads.run('details', ids, request, { signal: caller.signal });
            const departed = expect(departing).rejects.toMatchObject({ name: 'AbortError' });
            // Keep the last selected item alive after the shared caller leaves.
            const survivorId = ids.at(-1)!;
            const survivor = reads.run('details', [survivorId], request);
            const early = settledChunk ? reads.run('details', [ids[0]!], request) : undefined;
            try {
                await started.promise;
                if (early) {
                    publish(new Map(ids.slice(0, size / 2).map(id => [id, id])));
                    expect([...(await early)]).toEqual([[ids[0], ids[0]]]);
                }
                // Observe real native operations without replacing owner logic. Set membership
                // also catches retaining a whole-batch completed-item filter after fixing signals.
                // Only the synchronous abort turn counts, excluding setup/response/clock noise.
                const memberships = vi.spyOn(Set.prototype, 'has');
                const signalReads = vi.spyOn(AbortSignal.prototype, 'aborted', 'get');
                const signalReasons = vi.spyOn(AbortSignal.prototype, 'reason', 'get');
                let work: number;
                try {
                    caller.abort();
                    work = signalReads.mock.calls.length + signalReasons.mock.calls.length + memberships.mock.calls.length;
                } finally { signalReads.mockRestore(); signalReasons.mockRestore(); memberships.mockRestore(); }
                await departed;
                expect(physical.aborted).toBe(false);
                response.resolve(new Map(ids.map(id => [id, id])));
                expect([...(await survivor)]).toEqual([[survivorId, survivorId]]);
                return work;
            } finally {
                caller.abort();
                response.resolve(new Map(ids.map(id => [id, id])));
                await Promise.allSettled([departing, survivor, ...(early ? [early] : [])]);
                reads.reset();
            }
        }
        const small = await cancellationWork(32);
        const large = await cancellationWork(128);
        expect(small).toBeGreaterThan(0);
        // Four times the changed items may do at most four times the native observation work.
        expect(large, JSON.stringify({ small, large, settledChunk })).toBeLessThanOrEqual(small * 4);
    });

    it('settles each completed physical chunk for its borrowers before later chunks finish or fail', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const later = createDeferred<void>();
        const firstChunk = createDeferred<void>();
        const request = async (_ids: readonly string[], _signal: AbortSignal,
            publish?: (values: ReadonlyMap<string, string>) => void) => {
            await firstChunk.promise;
            publish?.(new Map([['a', 'first']]));
            await later.promise;
            throw new Error('later chunk failed');
        };
        const first = reads.run('details', ['a'], request);
        const all = reads.run('details', ['a', 'b'], request);
        const outcome = all.catch((error: unknown) => error);
        let observed: ReadonlyMap<string, string> | undefined;
        void first.then(value => { observed = value; }, () => {});
        try {
            firstChunk.resolve();
            await vi.waitFor(() => expect(observed?.get('a')).toBe('first'));
            later.resolve();
            expect(await outcome).toMatchObject({ message: 'later chunk failed' });
            expect([...(await first)]).toEqual([['a', 'first']]);
        } finally {
            firstChunk.resolve(); later.resolve();
            await outcome;
        }
    });

    it('cancels remaining physical work after an early borrower settles and the last pending borrower leaves', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const started = createDeferred<void>();
        const firstChunk = createDeferred<void>();
        let physicalSignal: AbortSignal | undefined;
        const request = async (_ids: readonly string[], signal: AbortSignal, publish: (values: ReadonlyMap<string, string>) => void) => {
            physicalSignal = signal;
            started.resolve();
            await firstChunk.promise;
            publish(new Map([['a', 'first']]));
            return await new Promise<ReadonlyMap<string, string>>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                if (signal.aborted) reject(signal.reason);
            });
        };
        const abort = new AbortController();
        const first = reads.run('details', ['a'], request);
        const later = reads.run('details', ['b'], request, { signal: abort.signal }).catch((error: unknown) => error);
        await started.promise;
        firstChunk.resolve();
        expect([...(await first)]).toEqual([['a', 'first']]);
        expect(physicalSignal?.aborted).toBe(false);
        abort.abort();
        await later;
        expect(physicalSignal?.aborted).toBe(true);
    });

    it('does not cancel the physical continuation after all selected chunks have already settled', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const started = createDeferred<void>();
        const response = createDeferred<ReadonlyMap<string, string>>();
        const caller = new AbortController();
        let physical!: AbortSignal;
        let publish!: (values: ReadonlyMap<string, string>) => void;
        const result = reads.run('details', ['a', 'b'], (_ids, signal, onChunk) => {
            physical = signal;
            publish = onChunk;
            started.resolve();
            return response.promise;
        }, { signal: caller.signal });
        try {
            await started.promise;
            publish(new Map([['a', 'A']]));
            publish(new Map([['b', 'B']]));
            expect([...(await result)]).toEqual([['a', 'A'], ['b', 'B']]);
            caller.abort();
            expect(physical.aborted).toBe(false);
        } finally {
            response.resolve(new Map());
            await result;
            reads.reset();
        }
    });
    it.each([33, 64])('gathers concurrent readers after %i asynchronous preparation steps', async preparationDepth => {
        const realTask = globalThis.setTimeout;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const reads = createScopedBatchResolutionSingleFlight<string>();
            const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
            const preparing = reads.reserve('details');
            const first = reads.run('details', ['a', 'b'], request);
            // Credential/carrier preparations have unequal promise depths.
            for (let depth = 0; depth < preparationDepth; depth += 1) await Promise.resolve();
            const second = preparing.run(['b', 'c'], request);
            // Observe a completed microtask checkpoint without advancing the
            // frozen timer queue used by consumer deadline/cleanup tests.
            await new Promise<void>(resolve => realTask(resolve, 0));
            expect(request.mock.calls.map(([ids]) => ids)).toEqual([['a', 'b', 'c']]);
            const [left, right] = await Promise.all([first, second]);
            expect([...left.keys()]).toEqual(['a', 'b']);
            expect([...right.keys()]).toEqual(['b', 'c']);
        } finally { vi.useRealTimers(); }
    });

    it('dispatches an unreserved first read promptly without advancing frozen timers', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const reads = createScopedBatchResolutionSingleFlight<string>();
            const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
            const result = reads.run('details', ['a'], request);
            await Promise.resolve();
            expect(request).toHaveBeenCalledTimes(1);
            expect([...await result]).toEqual([['a', 'a']]);
        } finally { vi.useRealTimers(); }
    });

    it('releases an aborted preparation without holding a ready borrower or selecting the departed ids', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const abort = new AbortController();
        const preparing = reads.reserve('details', { signal: abort.signal });
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
        const ready = reads.run('details', ['a'], request);
        await Promise.resolve();
        expect(request).not.toHaveBeenCalled();
        abort.abort();
        await expect(preparing.run(['b'], request)).rejects.toMatchObject({ name: 'AbortError' });
        expect([...await ready]).toEqual([['a', 'a']]);
        expect(request.mock.calls.map(([ids]) => ids)).toEqual([['a']]);
    });

    it('releases a failed preparation and does not hold other authority or projection partitions', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const scope = {};
        const preparing = reads.reserve('details', { scope });
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
        const ready = reads.run('details', ['held'], request, { scope });
        const independent = await Promise.all([
            reads.run('details', ['other-authority'], request, { scope: {} }),
            reads.run('messages', ['other-projection'], request, { scope }),
            reads.run('details', ['fresh'], request, { scope, fresh: true }),
        ]);
        expect(independent.map(result => [...result.keys()])).toEqual([['other-authority'], ['other-projection'], ['fresh']]);
        expect(request.mock.calls.some(([ids]) => ids.includes('held'))).toBe(false);
        preparing.release();
        preparing.release();
        expect([...await ready]).toEqual([['held', 'held']]);
    });

    it('isolates invalidation during preparation without holding or overwriting the successor', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const scope = {};
        const preparing = reads.reserve('details', { scope });
        const oldRequest = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, 'old'])));
        const old = reads.run('details', ['a'], oldRequest, { scope });
        await Promise.resolve();
        reads.invalidate(scope);
        const replacement = await reads.run('details', ['a'], async () => new Map([['a', 'new']]), { scope });
        expect([...replacement]).toEqual([['a', 'new']]);
        expect(oldRequest).not.toHaveBeenCalled();
        const prepared = preparing.run(['a', 'b'], oldRequest);
        expect([...await old]).toEqual([['a', 'old']]);
        expect([...await prepared]).toEqual([['a', 'old'], ['b', 'old']]);
        expect(oldRequest.mock.calls.map(([ids]) => ids)).toEqual([['a', 'b']]);
    });

    it('gathers matching authority paths without assigning reference ids', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const configuration = {};
        const material = {};
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
        const [left, right] = await Promise.all([
            reads.run('details', ['a', 'b'], request, { scope: [configuration, material] }),
            reads.run('details', ['b', 'c'], request, { scope: [configuration, material] }),
        ]);
        expect(request).toHaveBeenCalledTimes(1);
        expect([...left]).toEqual([['a', 'a'], ['b', 'b']]);
        expect([...right]).toEqual([['b', 'b'], ['c', 'c']]);
    });

    it('releases sibling waiters after a joined item fails while preserving an independent borrower', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        let rejectA!: (error: Error) => void;
        let signalB: AbortSignal | undefined;
        const first = reads.run('details', ['a'], () => new Promise((_resolve, reject) => { rejectA = reject; }));
        const firstFailure = expect(first).rejects.toThrow('a failed');
        await vi.waitFor(() => expect(rejectA).toBeTypeOf('function'));
        const mixed = reads.run('details', ['a', 'b'], (_ids, signal) => {
            signalB = signal;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('b cancelled')), { once: true }));
        });
        const mixedFailure = expect(mixed).rejects.toThrow('a failed');
        const survivor = new AbortController();
        const remaining = reads.run('details', ['b'], async () => new Map(), { signal: survivor.signal });
        const cancelled = expect(remaining).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(signalB).toBeDefined());
        rejectA(new Error('a failed'));
        await Promise.all([firstFailure, mixedFailure]);
        expect(signalB?.aborted).toBe(false);
        survivor.abort();
        await cancelled;
        expect(signalB?.aborted).toBe(true);
    });

    it('gathers overlapping demands once and preserves each caller selection', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, `value:${id}`])));
        const [left, right] = await Promise.all([
            reads.run('details', ['a', 'b', 'a'], request),
            reads.run('details', ['b', 'c'], request),
        ]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]?.[0]).toEqual(['a', 'b', 'c']);
        expect([...left]).toEqual([['a', 'value:a'], ['b', 'value:b']]);
        expect([...right]).toEqual([['b', 'value:b'], ['c', 'value:c']]);
        await reads.run('details', ['b'], request);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('keeps the overlapping survivor alive after the initiating caller leaves', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const caller = new AbortController();
        let finish!: (value: ReadonlyMap<string, string>) => void;
        let physical: AbortSignal | undefined;
        const request = vi.fn((_ids: readonly string[], signal: AbortSignal) => {
            physical = signal;
            return new Promise<ReadonlyMap<string, string>>(resolve => { finish = resolve; });
        });
        const left = reads.run('details', ['a', 'b'], request, { signal: caller.signal });
        const cancelled = expect(left).rejects.toMatchObject({ name: 'AbortError' });
        const right = reads.run('details', ['b', 'c'], request);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        caller.abort();
        await cancelled;
        expect(physical?.aborted).toBe(false);
        finish(new Map([['a', 'A'], ['b', 'B'], ['c', 'C']]));
        expect([...await right]).toEqual([['b', 'B'], ['c', 'C']]);
    });

    it('keeps projection, authority and explicit fresh witnesses separate', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const request = vi.fn(async (ids: readonly string[]) => new Map(ids.map(id => [id, id])));
        const scope = {};
        await Promise.all([
            reads.run('details', ['a'], request, { scope }),
            reads.run('details', ['a'], request, { scope: {} }),
            reads.run('messages', ['a'], request, { scope }),
            reads.run('details', ['a'], request, { scope, fresh: true }),
        ]);
        expect(request).toHaveBeenCalledTimes(4);
    });

    it('invalidates pending joins without cancelling incumbent borrowers', async () => {
        const reads = createScopedBatchResolutionSingleFlight<string>();
        const scope = {};
        let finish!: (value: ReadonlyMap<string, string>) => void;
        const old = reads.run('details', ['a'], () => new Promise<ReadonlyMap<string, string>>(resolve => { finish = resolve; }), { scope });
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        reads.invalidate(scope);
        const replacement = await reads.run('details', ['a'], async () => new Map([['a', 'new']]), { scope });
        finish(new Map([['a', 'old']]));
        expect([...await old]).toEqual([['a', 'old']]);
        expect([...replacement]).toEqual([['a', 'new']]);
    });
});
