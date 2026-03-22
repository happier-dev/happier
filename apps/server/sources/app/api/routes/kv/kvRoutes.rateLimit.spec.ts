import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("kvRoutes rate limits", () => {
    it("registers GET /v1/kv with an explicit rate limit", async () => {
        const { kvRoutes } = await import("./kvRoutes");
        const app = createFakeRouteApp();
        kvRoutes(app as any);

        expect(getRouteEntry(app, "GET", "/v1/kv").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
