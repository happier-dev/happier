import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("sessionPendingRoutes rate limits", () => {
    it("registers pending routes with explicit rate limits", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const app = createFakeRouteApp();
        sessionPendingRoutes(app as any);

        expect(getRouteEntry(app, "GET", "/v2/sessions/:sessionId/pending").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );

        expect(getRouteEntry(app, "POST", "/v2/sessions/:sessionId/pending/materialize-next").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
