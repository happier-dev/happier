import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForRpcTargetAvailability } from "./rpcAvailabilityWait";

function createCandidate(id: string) {
    return {
        id,
        timeout: vi.fn(),
    };
}

describe("waitForRpcTargetAvailability", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("polls until a target becomes available within the grace window", async () => {
        vi.useFakeTimers();
        const target = createCandidate("target-socket");
        const discoverTargets = vi
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([target]);

        const pending = waitForRpcTargetAvailability({
            graceMs: 20,
            pollMs: 5,
            discoverTargets,
            excludedSocketId: "caller-socket",
        });

        await vi.advanceTimersByTimeAsync(10);

        await expect(pending).resolves.toEqual({
            type: "target",
            target,
            hadMultipleTargets: false,
        });
        expect(discoverTargets).toHaveBeenCalledTimes(3);
    });

    it("returns method-not-available when the room stays empty through the grace window", async () => {
        vi.useFakeTimers();
        const discoverTargets = vi.fn().mockResolvedValue([]);

        const pending = waitForRpcTargetAvailability({
            graceMs: 10,
            pollMs: 5,
            discoverTargets,
        });

        await vi.advanceTimersByTimeAsync(15);

        await expect(pending).resolves.toEqual({
            type: "not-available",
        });
        expect(discoverTargets).toHaveBeenCalledTimes(3);
    });

    it('keeps an admitted wake invocation until its exact guest registers beyond ordinary discovery grace', async () => {
        vi.useFakeTimers();
        const target = createCandidate('reconnected-guest');
        let registered = false;
        const pending = waitForRpcTargetAvailability({ graceMs: 10, pollMs: 5,
            discoverTargets: async () => registered ? [target] : [],
            ...{ callerLifetime: { signal: new AbortController().signal, isCurrent: async () => true } },
        });
        await vi.advanceTimersByTimeAsync(30);
        registered = true;
        await vi.advanceTimersByTimeAsync(5);
        await expect(pending).resolves.toMatchObject({ type: 'target', target });
    });

    it.each(['cancel', 'retire'] as const)('ends an undispatched wake wait on original %s without selecting later work', async reason => {
        vi.useFakeTimers();
        const cancel = new AbortController();
        let current = true;
        const pending = waitForRpcTargetAvailability({ graceMs: 10, pollMs: 5, discoverTargets: async () => [],
            ...{ callerLifetime: { signal: cancel.signal, isCurrent: async () => current } },
        });
        await vi.advanceTimersByTimeAsync(30);
        if (reason === 'cancel') cancel.abort(); else current = false;
        await vi.advanceTimersByTimeAsync(5);
        await expect(pending).resolves.toEqual({ type: 'not-available' });
    });
});
