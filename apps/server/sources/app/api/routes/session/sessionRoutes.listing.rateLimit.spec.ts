import { describe, expect, it } from "vitest";

import { registerSessionRoutesAndGetHandler } from "./sessionRoutes.testkit";

describe("sessionRoutes listing rate limits", () => {
    it("registers session listing routes with explicit rate limits", async () => {
        const { app: v1App } = await registerSessionRoutesAndGetHandler("GET", "/v1/sessions");
        const v1Route = v1App.routes.get("GET /v1/sessions");
        expect((v1Route?.opts as any)?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );

        const { app: v2App } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions");
        const v2Route = v2App.routes.get("GET /v2/sessions");
        expect((v2Route?.opts as any)?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});

