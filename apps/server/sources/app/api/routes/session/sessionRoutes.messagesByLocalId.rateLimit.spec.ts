import { beforeAll, describe, expect, it } from "vitest";

import { preloadSessionRoutes, registerSessionRoutesAndGetHandler } from "./sessionRoutes.testkit";

describe("sessionRoutes v2 by-local-id rate limit", () => {
    beforeAll(async () => {
        await preloadSessionRoutes();
    }, 120_000);

    it("registers GET /v2/sessions/:sessionId/messages/by-local-id/:localId with an explicit rate limit", async () => {
        const { app } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions/:sessionId/messages/by-local-id/:localId");
        const route = app.routes.get("GET /v2/sessions/:sessionId/messages/by-local-id/:localId");
        expect((route?.opts as any)?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
