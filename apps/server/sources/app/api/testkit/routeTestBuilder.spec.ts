import { describe, expect, it } from "vitest";

import { createRouteTestBuilder } from "./routeTestBuilder";

describe("routeTestBuilder", () => {
    it("registers a route once and invokes it with merged request defaults", async () => {
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/test/:id",
            defaultRequest: {
                userId: "user-default",
                params: { id: "route-1" },
                headers: { "x-default": "default-header" },
            },
            registerRoutes(app) {
                app.post("/v1/test/:id", async (request: any) => ({
                    userId: request.userId,
                    params: request.params,
                    headers: request.headers,
                    body: request.body,
                }));
            },
        });

        const firstResult = await route.invoke({
            headers: { "x-extra": "extra-header" },
            body: { ok: true },
        });

        expect(firstResult.response).toEqual({
            userId: "user-default",
            params: { id: "route-1" },
            headers: { "x-default": "default-header", "x-extra": "extra-header" },
            body: { ok: true },
        });

        const secondResult = await route.invoke();

        expect(secondResult.reply).not.toBe(firstResult.reply);
        expect(secondResult.request.headers).toEqual({ "x-default": "default-header" });
    });

    it("reports when the requested route is not registered", () => {
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/missing",
            registerRoutes() {
                // Intentionally leave the target route unregistered.
            },
        });

        expect(route.routeExists).toBe(false);
    });
});
