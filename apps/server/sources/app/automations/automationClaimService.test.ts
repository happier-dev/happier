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

    it("builds a future lease expiry using the requested duration", () => {
        const lease = resolveClaimLeaseExpiresAt({
            now: new Date("2026-02-12T10:00:00.000Z"),
            leaseDurationMs: 30_000,
        });
        expect(lease.toISOString()).toBe("2026-02-12T10:00:30.000Z");
    });
});
