import { describe, expect, it } from "vitest";

import { createRouteTestBuilder } from "@/app/api/testkit/routeTestBuilder";
import { createServerFeatureGatedRouteApp } from "./serverFeatureGate";

describe("serverFeatureGate", () => {
    it("supports registering routes with the (path, handler) overload while still injecting a gate preHandler", async () => {
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/test",
            registerRoutes: (app) => {
                const gated = createServerFeatureGatedRouteApp(app, "bugReports", {
                    HAPPIER_FEATURE_BUG_REPORTS__ENABLED: "1",
                } as NodeJS.ProcessEnv);
                gated.get("/v1/test", async () => ({ ok: true }));
            },
        });

        const { response: out, reply } = await route.invoke();

        expect(out).toEqual({ ok: true });
        expect(reply.code).not.toHaveBeenCalledWith(404);
    });
});
