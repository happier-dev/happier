import { describe, expect, it } from "vitest";
import { FEATURE_IDS, readServerEnabledBit } from "@happier-dev/protocol";

import { createRouteTestBuilder } from "@/app/api/testkit/routeTestBuilder";
import { createServerFeatureGatedRouteApp, isServerFeatureEnabledForRequest, resolveServerFeaturesForGating } from "./serverFeatureGate";
import { serverFeatureRegistry } from "./serverFeatureRegistry";

describe("serverFeatureGate", () => {
    it("does not read unrelated diagnostic configuration while checking a Session sharing bit", () => {
        let capabilityReads = 0;
        const env: NodeJS.ProcessEnv = {};
        Object.defineProperty(env, "HAPPIER_SERVER_FLAVOR", {
            get: () => { capabilityReads += 1; return "light"; },
        });

        expect(isServerFeatureEnabledForRequest("sharing.session", env)).toBe(true);
        // The environment is a genuine boundary: flavor belongs only to release diagnostics.
        expect(capabilityReads).toBe(0);
    });

    it.each([
        {},
        { HAPPIER_BUILD_FEATURES_DENY: "sharing.session,sessions,browser.diagnostics,voice" },
        { HAPPIER_BUILD_FEATURES_ALLOW: "sessions,sharing.session" },
        { HAPPIER_FEATURE_TEAMS__ENABLED: "0", HAPPIER_FEATURE_AUTOMATIONS__ENABLED: "0", HAPPIER_FEATURE_BROWSER__ENABLED: "0" },
        { HAPPIER_FEATURE_SESSIONS_DRAFTS__ENABLED: "0", HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED: "0" },
        { HAPPIER_FEATURE_TEAMS__ENABLED: "malformed", HAPPIER_FEATURE_BROWSER_AUTOMATION__ENABLED: "malformed" },
    ] satisfies NodeJS.ProcessEnv[])("agrees with advertised bits for every catalog feature under %j", env => {
        const payload = resolveServerFeaturesForGating(env);
        for (const featureId of FEATURE_IDS) {
            expect(isServerFeatureEnabledForRequest(featureId, env), featureId)
                .toBe(readServerEnabledBit(payload, featureId) === true);
        }
    });

    it("reevaluates mutable deployment configuration rather than retaining a prior bit", () => {
        const env = { HAPPIER_FEATURE_TEAMS__ENABLED: "1" };
        expect(isServerFeatureEnabledForRequest("teams", env)).toBe(true);
        env.HAPPIER_FEATURE_TEAMS__ENABLED = "0";
        expect(isServerFeatureEnabledForRequest("teams", env)).toBe(false);
        env.HAPPIER_FEATURE_TEAMS__ENABLED = "1";
        expect(isServerFeatureEnabledForRequest("teams", env)).toBe(true);
    });

    it("declares every feature root each registered resolver can emit", () => {
        for (const env of [{}, { HAPPIER_FEATURE_TEAMS__ENABLED: "0", HAPPIER_FEATURE_BROWSER__ENABLED: "0" }]) {
            for (const resolver of serverFeatureRegistry) {
                expect(resolver.featureRoots).toEqual(Object.keys(resolver(env).features ?? {}));
            }
        }
    });

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

    it("returns 404 when the gated feature is disabled", async () => {
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/test",
            registerRoutes: (app) => {
                const gated = createServerFeatureGatedRouteApp(app, "bugReports", {
                    HAPPIER_FEATURE_BUG_REPORTS__ENABLED: "0",
                } as NodeJS.ProcessEnv);
                gated.get("/v1/test", async () => ({ ok: true }));
            },
        });

        const { response: out, reply } = await route.invoke();

        expect(out).toBeUndefined();
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
    });
});
