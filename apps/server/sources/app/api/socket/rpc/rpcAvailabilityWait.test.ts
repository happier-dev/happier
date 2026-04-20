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
});
