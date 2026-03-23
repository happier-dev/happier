import { describe, expect, it } from "vitest";

import { createSessionRouteTestBuilder } from "./sessionRoutes.testkit";

describe("sessionRoutes v1 messages rate limit", () => {
    it("registers GET /v1/sessions/:sessionId/messages with an explicit rate limit", async () => {
        const builder = await createSessionRouteTestBuilder("GET", "/v1/sessions/:sessionId/messages");
        const route = builder.app.routes.get("GET /v1/sessions/:sessionId/messages");
        const rateLimit = (route?.opts as any)?.config?.rateLimit ?? null;
        expect(rateLimit).toEqual(
            expect.objectContaining({
                max: expect.any(Number),
                timeWindow: expect.any(String),
            }),
        );
    });
});
