import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("feedRoutes rate limits", () => {
    it("registers GET /v1/feed with an explicit rate limit", async () => {
        const { feedRoutes } = await import("./feedRoutes");
        const app = createFakeRouteApp();
        feedRoutes(app as any);

        expect(getRouteEntry(app, "GET", "/v1/feed").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
