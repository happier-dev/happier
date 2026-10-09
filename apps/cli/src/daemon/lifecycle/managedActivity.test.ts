import { describe, expect, it } from 'vitest';

import { createManagedActivityInventory, createLiveWorkProducerGroup, type LiveWorkProducerV1, type LiveWorkItemV1 } from './managedActivity';

function producer() {
    let items: readonly LiveWorkItemV1[] = [];
    let coverage: 'complete' | 'unknown' = 'complete';
    const listeners = new Set<() => void>();
    return {
        source: { read: () => ({ items, coverage }), subscribe: (listener: () => void) => {
            listeners.add(listener); return () => { listeners.delete(listener); };
        } } satisfies LiveWorkProducerV1,
        change(next: typeof items, nextCoverage: typeof coverage = 'complete') {
            items = next; coverage = nextCoverage;
            for (const listener of listeners) listener();
        },
    };
}

describe('managed activity inventory', () => {
    it('does not confirm an asynchronous settled snapshot invalidated by a real owner edge', async () => {
        let notify = () => {};
        let release = () => {};
        let delayed = false;
        const source: LiveWorkProducerV1 = {
            read: () => delayed ? new Promise(resolve => { release = () => resolve({ items: [], coverage: 'complete' }); })
                : { items: [], coverage: 'complete' },
            subscribe: listener => { notify = listener; return () => {}; },
        };
        const inventory = createManagedActivityInventory({ producers: [source], now: () => 100 });
        expect((await inventory.readDecision()).kind).toBe('idle');
        delayed = true;
        const confirmation = inventory.readDecision();
        delayed = false;
        notify(); release();
        expect((await confirmation).kind).toBe('unknown');
        inventory.dispose();
    });
    it('observes late incumbent owners and releases retired owner subscriptions without inventing coverage', async () => {
        let current: LiveWorkProducerV1[] | null = null;
        const group = createLiveWorkProducerGroup(() => current);
        const inventory = createManagedActivityInventory({ producers: [group] });
        expect((await inventory.readDecision()).kind).toBe('unknown');
        const owner = producer();
        current = [owner.source];
        group.notifyChanged();
        expect((await inventory.readDecision()).kind).toBe('idle');
        owner.change([{ category: 'setup', ownerRef: 'actual-operation', attribution: { kind: 'unknown' }, state: 'active' }]);
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['setup'] });
        current = null;
        group.notifyChanged();
        expect((await inventory.readDecision()).kind).toBe('unknown');
        inventory.dispose(); group.dispose();
    });
    it('does not miss an active edge followed by settlement in the same turn', async () => {
        let now = 10;
        const source = producer();
        const inventory = createManagedActivityInventory({ producers: [source.source], now: () => now });
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 10 });
        now = 20;
        source.change([{ category: 'finite', ownerRef: 'operation', attribution: { kind: 'unknown' }, state: 'active' }]);
        now = 30;
        source.change([]);
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 30 });
        inventory.dispose();
    });
    it('uses real producer edges for aggregate idle, including service and transfer work absent from public counts', async () => {
        let now = 10;
        const service = producer();
        const transfer = producer();
        service.change([{ category: 'service', ownerRef: 'service', attribution: { kind: 'unknown' }, state: 'active' }]);
        const inventory = createManagedActivityInventory({ producers: [service.source, transfer.source], now: () => now });
        const decisions: unknown[] = [];
        const cleanup = inventory.subscribe(decision => { decisions.push(decision); });
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['service'] });
        now = 20;
        transfer.change([{ category: 'transfer', ownerRef: 'transfer', attribution: { kind: 'unknown' }, state: 'active' }]);
        service.change([]);
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['transfer'] });
        now = 30;
        transfer.change([]);
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 30 });
        now = 80;
        expect((await inventory.read()).idleSince).toBe(30);
        expect(decisions).toContainEqual({ kind: 'idle', since: 30 });
        cleanup(); inventory.dispose();
    });

    it('fails unknown coverage closed and starts a new idle interval only after coverage recovers', async () => {
        let now = 10;
        const source = producer();
        const inventory = createManagedActivityInventory({ producers: [source.source], now: () => now });
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 10 });
        source.change([], 'unknown');
        expect(await inventory.readDecision()).toEqual({ kind: 'unknown', reasons: ['coverage_unknown'] });
        now = 30;
        source.change([]);
        expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 30 });
        inventory.dispose();
    });

    it('retains internal operation to PTY association without transporting references or attribution', async () => {
        const source = producer();
        source.change([{ category: 'finite', ownerRef: 'private-operation', associatedTerminal: 'private-terminal',
            attribution: { kind: 'unknown' }, state: 'active' },
        { category: 'terminal', ownerRef: 'private-terminal', attribution: { kind: 'unknown' }, state: 'active' }]);
        const inventory = createManagedActivityInventory({ producers: [source.source] });
        expect((await inventory.read()).items).toHaveLength(2);
        expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['finite'] });
        inventory.dispose();
    });
});
