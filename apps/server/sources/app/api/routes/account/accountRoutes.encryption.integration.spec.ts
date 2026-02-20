import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";

let dbAccountFindUnique: any;
let dbAccountUpdate: any;

vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: any[]) => dbAccountFindUnique(...args),
            update: (...args: any[]) => dbAccountUpdate(...args),
        },
    },
}));

describe("accountRoutes (encryption mode integration)", () => {
    it("GET /v1/account/encryption returns account encryption mode", async () => {
        dbAccountFindUnique = vi.fn(async () => ({
            encryptionMode: "e2ee",
            encryptionModeUpdatedAt: new Date("2026-02-17T10:00:00.000Z"),
        }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v1/account/encryption");
        const reply = createReplyStub();

        const response = await handler({ userId: "u1" }, reply);

        expect(response).toEqual({ mode: "e2ee", updatedAt: 1771322400000 });
    });

    it("PATCH /v1/account/encryption returns 404 when account opt-out is disabled", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT = "0";

        dbAccountUpdate = vi.fn(async () => ({
            encryptionMode: "plain",
            encryptionModeUpdatedAt: new Date("2026-02-17T10:00:00.000Z"),
        }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const handler = getRouteHandler(app, "PATCH", "/v1/account/encryption");
        const reply = createReplyStub();

        const response = await handler({ userId: "u1", body: { mode: "plain" } }, reply);

        expect(response).toBeUndefined();
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
        expect(dbAccountUpdate).not.toHaveBeenCalled();
    });

    it("PATCH /v1/account/encryption updates the account mode when account opt-out is enabled", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT = "1";

        dbAccountUpdate = vi.fn(async () => ({
            encryptionMode: "plain",
            encryptionModeUpdatedAt: new Date("2026-02-17T11:00:00.000Z"),
        }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const handler = getRouteHandler(app, "PATCH", "/v1/account/encryption");
        const reply = createReplyStub();

        const response = await handler({ userId: "u1", body: { mode: "plain" } }, reply);

        expect(dbAccountUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "u1" },
                data: expect.objectContaining({ encryptionMode: "plain", encryptionModeUpdatedAt: expect.any(Date) }),
            }),
        );
        expect(response).toEqual({ mode: "plain", updatedAt: 1771326000000 });
    });
});
