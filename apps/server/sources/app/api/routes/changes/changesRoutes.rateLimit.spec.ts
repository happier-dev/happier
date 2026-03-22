import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("changesRoutes rate limits", () => {
    it("registers GET /v2/changes with an explicit rate limit", async () => {
        const { changesRoutes } = await import("./changesRoutes");
        const app = createFakeRouteApp();
        changesRoutes(app as any);
        expect(getRouteEntry(app, "GET", "/v2/cursor").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
        expect(getRouteEntry(app, "GET", "/v2/changes").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
