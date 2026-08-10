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
        const { response } = await route.invoke();
        expect(response).toEqual({ ok: true });
    });

    it("reports an exact deployed source revision when the release environment provides one", async () => {
        const prior = process.env.HAPPIER_RELEASE_SOURCE_SHA;
        process.env.HAPPIER_RELEASE_SOURCE_SHA = "a".repeat(40);
        try {
            const route = createRouteTestBuilder({
                method: "GET",
                path: "/v1/version",
                registerRoutes(app) {
                    versionRoutes(app as any);
                },
            });
            const { response } = await route.invoke();
            expect(response).toEqual({ ok: true, source_sha: "a".repeat(40) });
        } finally {
            if (prior === undefined) delete process.env.HAPPIER_RELEASE_SOURCE_SHA;
            else process.env.HAPPIER_RELEASE_SOURCE_SHA = prior;
        }
    });
});
