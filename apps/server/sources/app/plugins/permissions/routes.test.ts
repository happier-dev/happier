import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp } from "@/app/api/testkit/routeHarness";
import { requirePresentUser } from "@/app/api/utils/requirePresentUser";
import { registerApiRoutes } from "@/app/api/api";
import { registerPluginPermissionGrantRoutes } from "./routes";

const ROUTES = [
    "POST /v1/plugins/permissions/grants/list",
    "POST /v1/plugins/permissions/grants/request",
    "POST /v1/plugins/permissions/grants/grant",
    "POST /v1/plugins/permissions/grants/revoke",
    "POST /v1/plugins/permissions/grants/dismissRequest",
] as const;

describe("plugin permission grant routes", () => {
    it("mounts grant operations with the authority policy each decision requires", () => {
        const app = createFakeRouteApp();
        registerApiRoutes(app as any);

        for (const route of ROUTES) {
            const entry = app.routes.get(route);
            expect(entry, route).toBeDefined();
        }
        // Reads and provenance-carrying branches admit any authenticated
        // credential; the signed publisher proof carries the plugin authority.
        for (const route of [
            "POST /v1/plugins/permissions/grants/list",
            "POST /v1/plugins/permissions/grants/request",
            "POST /v1/plugins/permissions/grants/revoke",
        ] as const) {
            expect(app.routes.get(route)?.opts.preHandler).toBe(app.authenticate);
        }
        // Human grant decisions are present-user only.
        for (const route of [
            "POST /v1/plugins/permissions/grants/grant",
            "POST /v1/plugins/permissions/grants/dismissRequest",
        ] as const) {
            expect(app.routes.get(route)?.opts.preHandler).toEqual([app.authenticate, requirePresentUser]);
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

    it("does not continue user-side revocation when a reply adapter returns undefined after denial", async () => {
        const app = createFakeRouteApp();
        const revoke = vi.fn(async () => ({ grant: { id: "grant-1" } }));
        registerPluginPermissionGrantRoutes(app as any, {
            operations: {
                list: vi.fn(),
                request: vi.fn(),
                grant: vi.fn(),
                revoke,
                dismissRequest: vi.fn(),
            } as never,
        });
        const entry = app.routes.get("POST /v1/plugins/permissions/grants/revoke");
        const send = vi.fn(() => undefined);
        const reply = {
            code: vi.fn(() => ({ send })),
        };

        await expect(entry!.handler({
            userId: "user-1",
            authAuthority: "account_automation",
            body: { grantId: "grant-1" },
        }, reply)).resolves.toBeUndefined();

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(send).toHaveBeenCalledWith({ error: "present_user_required" });
        expect(revoke).not.toHaveBeenCalled();
    });

    it("rejects caller-stamped plugin list input without the signed publisher proof", async () => {
        const app = createFakeRouteApp();
        const list = vi.fn(async () => ({ grants: [], pendingRequests: [] }));
        registerPluginPermissionGrantRoutes(app as any, {
            operations: {
                list,
                request: vi.fn(),
                grant: vi.fn(),
                revoke: vi.fn(),
                dismissRequest: vi.fn(),
            } as never,
        });
        const entry = app.routes.get("POST /v1/plugins/permissions/grants/list");
        const reply = {
            code: vi.fn(function code() { return reply; }),
            send: vi.fn((payload) => payload),
        };

        const result = await entry!.handler({
            userId: "user-1",
            method: "POST",
            headers: {},
            body: {
                caller: {
                    machineId: "machine-1",
                    materializationId: "materialization-1",
                    pluginId: "acme.voice",
                },
            },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(result).toMatchObject({ error: "plugin_permission_grant_publisher_proof_required" });
        expect(list).not.toHaveBeenCalled();
    });
});
