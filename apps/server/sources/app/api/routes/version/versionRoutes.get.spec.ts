import { describe, expect, it } from "vitest";

import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { versionRoutes } from "./versionRoutes";

describe("versionRoutes GET /v1/version", () => {
    it("responds with ok=true for server validation probes", async () => {
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/version",
            registerRoutes(app) {
                versionRoutes(app as any);
            },
        });

        expect(route.handler).toBeTypeOf("function");

        const { response: res } = await route.invoke();
        expect(res).toEqual({ ok: true });
    });
});
