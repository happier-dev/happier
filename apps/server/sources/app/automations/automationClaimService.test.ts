import { describe, expect, it } from "vitest";

import { isRunClaimableState, resolveClaimLeaseExpiresAt } from "./automationClaimService";

describe("automationClaimService helpers", () => {
    it("allows claiming queued runs and expired claimed/running runs", () => {
        expect(isRunClaimableState({ state: "queued", leaseExpiresAt: null, now: new Date() })).toBe(true);
        expect(
            isRunClaimableState({
                state: "claimed",
                leaseExpiresAt: new Date("2026-02-12T09:59:00.000Z"),
                now: new Date("2026-02-12T10:00:00.000Z"),
            }),
        ).toBe(true);
        expect(
            isRunClaimableState({
                state: "running",
                leaseExpiresAt: new Date("2026-02-12T09:59:00.000Z"),
                now: new Date("2026-02-12T10:00:00.000Z"),
            }),
        ).toBe(true);
    });

    it("rejects non-claimable states and active leases", () => {
        expect(
            isRunClaimableState({
                state: "claimed",
                leaseExpiresAt: new Date("2026-02-12T10:05:00.000Z"),
                now: new Date("2026-02-12T10:00:00.000Z"),
            }),
        ).toBe(false);
        expect(isRunClaimableState({ state: "running", leaseExpiresAt: null, now: new Date() })).toBe(false);
    });

    it("reclaims pause_requested only with an expired nonnull lease", () => {
        const now = new Date("2026-02-12T10:00:00.000Z");
        expect(isRunClaimableState({ state: "pause_requested", leaseExpiresAt: null, now })).toBe(false);
        expect(isRunClaimableState({ state: "pause_requested", leaseExpiresAt: now, now })).toBe(false);
        expect(isRunClaimableState({ state: "pause_requested", leaseExpiresAt: new Date(now.getTime() - 1), now })).toBe(true);
        expect(isRunClaimableState({ state: "paused", leaseExpiresAt: new Date(now.getTime() - 1), now })).toBe(false);
    });

    it("requires the first millisecond after lease expiry before reclaim", () => {
        const leaseExpiresAt = new Date("2026-02-12T10:05:00.000Z");
        expect(isRunClaimableState({
            state: "claimed",
            leaseExpiresAt,
            now: leaseExpiresAt,
        })).toBe(false);
        expect(isRunClaimableState({
            state: "claimed",
            leaseExpiresAt,
            now: new Date("2026-02-12T10:05:00.001Z"),
        })).toBe(true);
    });

    it.each([1_000, 30_000, 3_600_000])("builds a future lease expiry using the requested duration (%i)", leaseDurationMs => {
        const now = new Date("2026-02-12T10:00:00.000Z");
        const lease = resolveClaimLeaseExpiresAt({
            now,
            leaseDurationMs,
        });
        expect(lease.getTime() - now.getTime()).toBe(leaseDurationMs);
    });
});
