import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForRpcTargetAvailability } from "./rpcAvailabilityWait";

function createCandidate(id: string) {
    return {
        id,
        timeout: vi.fn(),
    };
}

describe("waitForRpcTargetAvailability", () => {
    it('parks an unbounded observation without timers or repeated discovery, and releases it on cancellation', async () => {
        vi.useFakeTimers();
        const cancel = new AbortController();
        const discoverTargets = vi.fn(async () => []);
        const unsubscribe = vi.fn();
        const pending = waitForRpcTargetAvailability({ graceMs: null, pollMs: 5,
            signal: cancel.signal, discoverTargets, subscribeToAvailability: () => unsubscribe });
        let settled = false;
        void pending.then(() => { settled = true; });
        try {
            await vi.advanceTimersByTimeAsync(60_000);
            expect(settled).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
            expect(discoverTargets).toHaveBeenCalledTimes(1);
        } finally {
            cancel.abort();
            await pending;
        }
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does no repeated census during an idle held-watch minute, then rediscovers once on arrival', async () => {
        vi.useFakeTimers();
        const cancel = new AbortController();
        const target = createCandidate('arriving-client');
        let registered = false;
        let wake = () => {};
        const discoverTargets = vi.fn(async () => registered ? [target] : []);
        const pending = waitForRpcTargetAvailability({ graceMs: 10, pollMs: 5, discoverTargets,
            callerLifetime: { signal: cancel.signal, isCurrent: async () => true },
            subscribeToAvailability: listener => { wake = listener; return () => {}; },
        });
        try {
            await vi.advanceTimersByTimeAsync(60_000);
            console.info('RPC_AVAILABILITY_IDLE_MINUTE', discoverTargets.mock.calls.length);
            expect(discoverTargets).toHaveBeenCalledTimes(1);
            registered = true;
            wake();
            await vi.advanceTimersByTimeAsync(0);
            await expect(pending).resolves.toMatchObject({ type: 'target', target });
            expect(discoverTargets).toHaveBeenCalledTimes(2);
        } finally {
            cancel.abort();
            await pending;
        }
    });

    it("discovers once on a registration hint within the grace window", async () => {
        vi.useFakeTimers();
        const target = createCandidate("target-socket");
        const discoverTargets = vi
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([target]);
        let wake = () => {};

        const pending = waitForRpcTargetAvailability({
            graceMs: 20,
            pollMs: 5,
            discoverTargets,
            subscribeToAvailability: listener => { wake = listener; return () => {}; },
            excludedSocketId: "caller-socket",
        });

        await vi.advanceTimersByTimeAsync(10);
        wake();

        await expect(pending).resolves.toEqual({
            type: "target",
            target,
            hadMultipleTargets: false,
        });
        expect(discoverTargets).toHaveBeenCalledTimes(2);
    });

    it("returns method-not-available when the room stays empty through the grace window", async () => {
        vi.useFakeTimers();
        const discoverTargets = vi.fn().mockResolvedValue([]);

        const pending = waitForRpcTargetAvailability({
            graceMs: 10,
            pollMs: 5,
            discoverTargets,
            subscribeToAvailability: () => () => {},
        });

        await vi.advanceTimersByTimeAsync(15);

        await expect(pending).resolves.toEqual({
            type: "not-available",
        });
        expect(discoverTargets).toHaveBeenCalledTimes(1);
    });

    it('keeps an admitted wake invocation until its exact guest registers beyond ordinary discovery grace', async () => {
        vi.useFakeTimers();
        const target = createCandidate('reconnected-guest');
        let registered = false;
        let wake = () => {};
        const pending = waitForRpcTargetAvailability({ graceMs: 10, pollMs: 5,
            discoverTargets: async () => registered ? [target] : [],
            subscribeToAvailability: listener => { wake = listener; return () => {}; },
            ...{ callerLifetime: { signal: new AbortController().signal, isCurrent: async () => true } },
        });
        await vi.advanceTimersByTimeAsync(30);
        registered = true;
        wake();
        await vi.advanceTimersByTimeAsync(5);
        await expect(pending).resolves.toMatchObject({ type: 'target', target });
    });

    it.each(['cancel', 'retire'] as const)('ends an undispatched wake wait on original %s without selecting later work', async reason => {
        vi.useFakeTimers();
        const cancel = new AbortController();
        let current = true;
        const pending = waitForRpcTargetAvailability({ graceMs: 10, pollMs: 5, discoverTargets: async () => [],
            subscribeToAvailability: () => () => {},
            ...{ callerLifetime: { signal: cancel.signal, isCurrent: async () => current } },
        });
        await vi.advanceTimersByTimeAsync(30);
        if (reason === 'cancel') cancel.abort(); else current = false;
        await vi.advanceTimersByTimeAsync(5);
        await expect(pending).resolves.toEqual({ type: 'not-available' });
    });

    it('remembers an arrival during the initial census and releases the subscription after selection', async () => {
        const target = createCandidate('during-census');
        let wake = () => {};
        const unsubscribe = vi.fn();
        let calls = 0;
        const result = await waitForRpcTargetAvailability({ graceMs: 20, pollMs: 5,
            subscribeToAvailability: listener => { wake = listener; return unsubscribe; },
            discoverTargets: async () => { if (++calls === 1) { wake(); return []; } return [target]; },
        });
        expect(result).toMatchObject({ type: 'target', target });
        expect(calls).toBe(2);
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('aborts an ordinary grace wait without another census and removes its listener', async () => {
        vi.useFakeTimers();
        const cancel = new AbortController();
        const unsubscribe = vi.fn();
        const discoverTargets = vi.fn(async () => []);
        const pending = waitForRpcTargetAvailability({ graceMs: 60_000, pollMs: 5, discoverTargets,
            signal: cancel.signal, subscribeToAvailability: () => unsubscribe,
        });
        await vi.advanceTimersByTimeAsync(10);
        cancel.abort();
        await expect(pending).resolves.toEqual({ type: 'not-available' });
        expect(discoverTargets).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
