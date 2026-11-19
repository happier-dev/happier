import { afterEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../../../../package.json";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { versionRoutes } from "./versionRoutes";

describe("versionRoutes GET /v1/version", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("includes the server package version in reachability responses", async () => {
        vi.stubEnv("HAPPIER_RELEASE_SOURCE_SHA", "");
        await withAuthenticatedTestApp(versionRoutes, async (app) => {
            const response = await app.inject({ method: "GET", url: "/v1/version" });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, version: packageJson.version });
        });
    });

    it("includes the deployed source revision when provided", async () => {
        vi.stubEnv("HAPPIER_RELEASE_SOURCE_SHA", "a".repeat(40));
        await withAuthenticatedTestApp(versionRoutes, async (app) => {
            const response = await app.inject({ method: "GET", url: "/v1/version" });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, version: packageJson.version, source_sha: "a".repeat(40) });
        });
    });
});
