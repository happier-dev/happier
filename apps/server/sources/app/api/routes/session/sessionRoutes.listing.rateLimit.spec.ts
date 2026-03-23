import { describe, expect, it } from "vitest";

import { createSessionRouteTestBuilder } from "./sessionRoutes.testkit";

describe("sessionRoutes listing rate limits", () => {
    it("registers session listing routes with explicit rate limits", async () => {
        const v1Builder = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const v1Route = v1Builder.app.routes.get("GET /v1/sessions");
        expect((v1Route?.opts as any)?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );

        const v2Builder = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const v2Route = v2Builder.app.routes.get("GET /v2/sessions");
        expect((v2Route?.opts as any)?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
