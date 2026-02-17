import { describe, expect, it } from "vitest";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { createServerFeatureGatedRouteApp } from "./serverFeatureGate";

describe("serverFeatureGate", () => {
    it("supports registering routes with the (path, handler) overload while still injecting a gate preHandler", async () => {
        const app = createFakeRouteApp();
        const gated = createServerFeatureGatedRouteApp(app, "bugReports", {
            HAPPIER_FEATURE_BUG_REPORTS__ENABLED: "1",
        } as NodeJS.ProcessEnv);

        gated.get("/v1/test", async () => ({ ok: true }));

        const handler = getRouteHandler(app, "GET", "/v1/test");
        const reply = createReplyStub();
        const out = await handler({}, reply);

        expect(out).toEqual({ ok: true });
        expect(reply.code).not.toHaveBeenCalledWith(404);
    });
});

