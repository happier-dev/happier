import { describe, expect, it } from "vitest";

import { resolveBucketBounds } from "./bucketBounds";

describe("resolveBucketBounds", () => {
    it.each([
        ["hour", "2026-07-09T12:34:56.000Z", "2026-07-09T12:00:00.000Z", "2026-07-09T13:00:00.000Z"],
        ["day", "2026-07-09T12:34:56.000Z", "2026-07-09T00:00:00.000Z", "2026-07-10T00:00:00.000Z"],
        ["week", "2026-07-12T12:34:56.000Z", "2026-07-06T00:00:00.000Z", "2026-07-13T00:00:00.000Z"],
        ["month", "2026-07-09T12:34:56.000Z", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ] as const)("resolves %s UTC bounds", (granularity, timestamp, expectedStart, expectedEnd) => {
        const bounds = resolveBucketBounds(granularity, Date.parse(timestamp), 0);
        expect(new Date(bounds.bucketStartMs).toISOString()).toBe(expectedStart);
        expect(new Date(bounds.bucketEndMs).toISOString()).toBe(expectedEnd);
    });

    it("uses minutes east of UTC and keeps Monday as the local week start", () => {
        const day = resolveBucketBounds("day", Date.parse("2026-07-01T23:30:00.000Z"), 120);
        expect(new Date(day.bucketStartMs).toISOString()).toBe("2026-07-01T22:00:00.000Z");

        const week = resolveBucketBounds("week", Date.parse("2026-07-05T23:30:00.000Z"), 120);
        expect(new Date(week.bucketStartMs).toISOString()).toBe("2026-07-05T22:00:00.000Z");
        expect(new Date(week.bucketEndMs).toISOString()).toBe("2026-07-12T22:00:00.000Z");
    });
});
