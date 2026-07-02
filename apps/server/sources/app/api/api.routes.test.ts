import { describe, expect, it } from "vitest";

import { createFakeRouteApp } from "@/app/api/testkit/routeHarness";

import * as apiModule from "./api";

type FakeRouteApp = ReturnType<typeof createFakeRouteApp>;

describe("registerApiRoutes", () => {
    it("mounts review comment routes on the API app", () => {
        const registerApiRoutes = (apiModule as unknown as Readonly<{
            registerApiRoutes?: (app: FakeRouteApp) => void;
        }>).registerApiRoutes;
        expect(registerApiRoutes).toEqual(expect.any(Function));

        const app = createFakeRouteApp();
        registerApiRoutes?.(app);

        expect(app.routes.has("GET /v1/reviews/comments")).toBe(true);
        expect(app.routes.has("POST /v1/reviews/comments")).toBe(true);
        expect(app.routes.has("POST /v1/local-services/preview")).toBe(true);
        expect(app.routes.has("GET /v1/local-services/public/:exposureId/*")).toBe(true);
    });
});
