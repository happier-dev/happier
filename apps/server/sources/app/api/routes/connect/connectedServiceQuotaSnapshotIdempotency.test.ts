import { describe, expect, it } from "vitest";

import { buildNewerQuotaSnapshotWriteGuard } from "./connectedServiceQuotaSnapshotIdempotency";

describe("connectedServiceQuotaSnapshotIdempotency", () => {
    it("builds a stale-write guard that still allows a concurrent newer current row to accept a newer incoming snapshot", () => {
        const incomingFetchedAtMs = Date.UTC(2026, 0, 1, 0, 0, 10);

        expect(buildNewerQuotaSnapshotWriteGuard({
            id: "quota-row",
            incomingFetchedAtMs,
        })).toEqual({
            id: "quota-row",
            OR: [
                { fetchedAt: null },
                { fetchedAt: { lt: new Date(incomingFetchedAtMs) } },
            ],
        });
    });
});
