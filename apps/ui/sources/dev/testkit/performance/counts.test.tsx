import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createElement, StrictMode, Suspense } from 'react';

// Instrument tests do not need the root fixture/catalog import graph.
import { renderHook } from '../hooks/renderHook';
import { standardCleanup } from '../cleanup/standardCleanup';
import { countReadBorrowers, countStoreNotifications, countTransportRequests, createRenderCommitCounter, useRenderCommitCounter } from './counts';
import { installTimerCensus } from './timerCensus';

afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('performance count instruments', () => {
    it('leaves the platform clock intact across repeated fake-clock census cleanup', () => {
        const platformClock = { setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask, Date };
        for (let pass = 0; pass < 3; pass += 1) {
            vi.useFakeTimers();
            const census = installTimerCensus();
            const timer = setTimeout(() => {}, 20);
            clearTimeout(timer);
            census.stop();
            vi.restoreAllMocks();
            vi.useRealTimers();
            expect({ setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask, Date }).toEqual(platformClock);
        }
        // A later real-clock test also restores mocks. Retired census spies must
        // not reinstall the old fake-clock functions after fake mode has ended.
        vi.restoreAllMocks();
        vi.useRealTimers();
        expect({ setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask, Date }).toEqual(platformClock);
    });

    it('counts hook renders and commits independently of the mount baseline', async () => {
        const counter = createRenderCommitCounter();
        const hook = await renderHook(({ value }: { value: number }) => {
            useRenderCommitCounter(counter);
            return value;
        }, { initialProps: { value: 1 } });
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        counter.reset();
        await hook.rerender({ value: 2 });
        expect(hook.getCurrent()).toBe(2);
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
    });

    it('does not count a suspended render as a committed consumer', async () => {
        const counter = createRenderCommitCounter();
        const pending = new Promise<void>(() => {});
        const hook = await renderHook(({ suspended }: { suspended: boolean }) => {
            useRenderCommitCounter(counter);
            if (suspended) throw pending;
            return 'ready';
        }, {
            initialProps: { suspended: true },
            wrapper: ({ children }) => createElement(Suspense, { fallback: null }, children),
        });
        expect(counter.read().renders).toBeGreaterThan(0);
        expect(counter.read().commits).toBe(0);
        counter.reset();
        await hook.rerender({ suspended: false });
        expect(hook.getCurrent()).toBe('ready');
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
    });

    it('counts one commit when StrictMode replays an effect after rendering twice', async () => {
        const counter = createRenderCommitCounter();
        const hook = await renderHook(({ value }: { value: number }) => {
            useRenderCommitCounter(counter);
            return value;
        }, {
            initialProps: { value: 1 },
            wrapper: ({ children }) => createElement(StrictMode, null, children),
        });
        expect(counter.read()).toEqual({ renders: 2, commits: 1 });
        counter.reset();
        await hook.rerender({ value: 2 });
        expect(counter.read()).toEqual({ renders: 2, commits: 1 });
    });

    it('records every real Zustand notification with changed top-level keys, including empty merges', () => {
        const store = createStore(() => ({ row: { id: 'a' }, ready: false }));
        const counter = countStoreNotifications(store);
        store.setState(state => state);
        expect(counter.read()).toEqual([]);
        store.setState({});
        store.setState({ ready: true });
        expect(counter.read()).toEqual([[], ['ready']]);
        counter.reset();
        store.setState({ row: { id: 'a' } });
        expect(counter.read()).toEqual([['row']]);
        counter.stop();
        store.setState({ ready: false });
        expect(counter.read()).toEqual([['row']]);
    });

    it('counts physical requests by caller-selected route even when transport rejects', async () => {
        const transport = countTransportRequests(async (path: string) => {
            if (path === '/failed') throw new Error('transport rejected');
            return path;
        }, path => `GET ${path}`);
        expect(await transport.request('/sessions')).toBe('/sessions');
        await transport.request('/sessions');
        await expect(transport.request('/failed')).rejects.toThrow('transport rejected');
        expect(transport.read()).toEqual({ 'GET /sessions': 2, 'GET /failed': 1 });
        transport.reset();
        expect(transport.read()).toEqual({});
    });

    it('counts borrower provenance before a queued read and retains cardinalities without arguments', async () => {
        const held: Array<() => void> = [];
        const reads = countReadBorrowers((ids: readonly string[], _secret: string) => new Promise<readonly string[]>(resolve => {
            held.push(() => resolve(ids));
        }), ids => ids);
        function initiateRead() { return reads.request(['private-session', 'private-session', 'another-session'], 'private-token'); }
        const pending = [initiateRead(), initiateRead()];
        const observed = reads.read();
        expect(observed.reduce((count, borrower) => count + borrower.calls, 0)).toBe(2);
        expect(observed.reduce((count, borrower) => count + borrower.idCount, 0)).toBe(4);
        expect(observed.every(borrower => borrower.provenance[0]?.method === 'initiateRead')).toBe(true);
        expect(observed[0]?.provenance[0]).toMatchObject({ source: 'apps/ui/sources/dev/testkit/performance/counts.test.tsx' });
        expect(JSON.stringify(observed)).not.toMatch(/private-session|another-session|private-token/);
        for (const release of held) release();
        expect(await Promise.all(pending)).toEqual([
            ['private-session', 'private-session', 'another-session'],
            ['private-session', 'private-session', 'another-session'],
        ]);
        reads.reset();
        expect(reads.read()).toEqual([]);
    });

    it('censuses live timers, preserves scheduling, and keeps unattributed timers visible', () => {
        vi.useFakeTimers();
        const census = installTimerCensus(stack => stack.includes('namedConsumer') ? 'relative age' : null);
        const fired = vi.fn();
        function namedConsumer() { return setTimeout(fired, 20); }
        namedConsumer();
        const orphan = setInterval(fired, 50);
        expect(census.read()).toEqual([
            { kind: 'timeout', delayMs: 20, consumer: 'relative age' },
            { kind: 'interval', delayMs: 50, consumer: null },
        ]);
        vi.advanceTimersByTime(20);
        expect(fired).toHaveBeenCalledTimes(1);
        expect(census.readFires()).toEqual({ timeout: 1, interval: 0 });
        expect(census.read()).toEqual([{ kind: 'interval', delayMs: 50, consumer: null }]);
        vi.advanceTimersByTime(130);
        expect(fired).toHaveBeenCalledTimes(4);
        expect(census.readFires()).toEqual({ timeout: 1, interval: 3 });
        clearInterval(orphan);
        expect(census.read()).toEqual([]);
        const cancelled = setTimeout(fired, 20);
        clearTimeout(cancelled);
        expect(census.read()).toEqual([]);
        census.stop();
        setTimeout(fired, 20);
        expect(census.read()).toEqual([]);
    });
});
