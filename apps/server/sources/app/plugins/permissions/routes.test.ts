import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp } from "@/app/api/testkit/routeHarness";
import { registerApiRoutes } from "@/app/api/api";
import { registerPluginPermissionGrantRoutes } from "./routes";

const ROUTES = [
    "POST /v1/plugins/installations/manifests/list",
    "POST /v1/plugins/installations/manifests/upsert",
    "POST /v1/plugins/installations/manifests/delete",
    "POST /v1/plugins/permissions/grants/list",
    "POST /v1/plugins/permissions/grants/request",
    "POST /v1/plugins/permissions/grants/grant",
    "POST /v1/plugins/permissions/grants/revoke",
    "POST /v1/plugins/permissions/grants/dismissRequest",
] as const;

describe("plugin permission grant routes", () => {
    it("mounts grant operations with authenticated prehandlers", () => {
        const app = createFakeRouteApp();
        registerApiRoutes(app as any);

        for (const route of ROUTES) {
            const entry = app.routes.get(route);
            expect(entry, route).toBeDefined();
            expect(entry?.opts.preHandler).toBe(app.authenticate);
        }
    });

    it("returns typed sanitized errors for malformed grant route bodies", async () => {
        const app = createFakeRouteApp();
        registerPluginPermissionGrantRoutes(app as any, {
            operations: {
                list: vi.fn(async () => ({ grants: [], pendingRequests: [] })),
                request: vi.fn(async () => { throw new Error("operation should not receive malformed input"); }),
                grant: vi.fn(async () => { throw new Error("operation should not receive malformed input"); }),
                revoke: vi.fn(async () => { throw new Error("operation should not receive malformed input"); }),
                dismissRequest: vi.fn(async () => { throw new Error("operation should not receive malformed input"); }),
            },
        });

        const invalidRoutes = [
            "POST /v1/plugins/permissions/grants/request",
            "POST /v1/plugins/permissions/grants/grant",
            "POST /v1/plugins/permissions/grants/revoke",
            "POST /v1/plugins/permissions/grants/dismissRequest",
        ] as const;

        for (const route of invalidRoutes) {
            const entry = app.routes.get(route);
            expect(entry, route).toBeDefined();
            const reply = {
                code: vi.fn(function code() { return reply; }),
                send: vi.fn((payload) => payload),
            };

            const result = await entry!.handler({ userId: "user-1", body: {} }, reply);

            expect(reply.code).toHaveBeenCalledWith(400);
            expect(result).toMatchObject({ error: "plugin_permission_grant_invalid_request" });
        }
    });
});
