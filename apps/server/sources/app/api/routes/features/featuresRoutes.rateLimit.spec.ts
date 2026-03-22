import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("featuresRoutes rate limits", () => {
    it("registers GET /v1/features with an explicit rate limit", async () => {
        const { featuresRoutes } = await import("./featuresRoutes");
        const app = createFakeRouteApp();
        featuresRoutes(app as any);

        expect(getRouteEntry(app, "GET", "/v1/features").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
