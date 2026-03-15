import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "../../testkit/routeHarness";
import { createInTxHarness } from "../../testkit/txHarness";

let txAccountFindUnique: any;
let txAccountUpdateMany: any;
let dbAccountFindUnique: any;

vi.mock("@/storage/inTx", () => {
    const harness = createInTxHarness(() => ({
        account: {
            findUnique: (...args: any[]) => txAccountFindUnique(...args),
            updateMany: (...args: any[]) => txAccountUpdateMany(...args),
        },
    }));
    return { afterTx: harness.afterTx, inTx: harness.inTx };
});

vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged: vi.fn(async () => 1) }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildUpdateAccountUpdate: vi.fn(() => ({ id: "u", seq: 1, body: { t: "update-account" } })),
}));
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "upd-id") }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: any[]) => dbAccountFindUnique(...args),
        },
    },
}));

describe("accountRoutes (/v2/account/settings) (integration)", () => {
    it("GET /v2/account/settings returns plain envelope for a plain account", async () => {
        dbAccountFindUnique = vi.fn(async () => ({
            settings: JSON.stringify({ t: "plain", v: { schemaVersion: 2, notificationsSettingsV1: { v: 1 } } }),
            settingsVersion: 3,
            publicKey: null,
            encryptionMode: "plain",
        }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const handler = getRouteHandler(app, "GET", "/v2/account/settings");
        const reply = createReplyStub();

        const response = await handler({ userId: "u1" }, reply);
        expect(response).toEqual({
            content: { t: "plain", v: expect.any(Object) },
            version: 3,
        });
        expect((response as any).content.v.schemaVersion).toBe(2);
    });

    it("POST /v1/account/settings fails fast for a plain account", async () => {
        txAccountFindUnique = vi.fn(async () => ({
            settings: null,
            settingsVersion: 0,
            publicKey: null,
            encryptionMode: "plain",
        }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v1/account/settings");
        const reply = createReplyStub();

        const response = await handler({ userId: "u1", body: { settings: "ciphertext", expectedVersion: 0 } }, reply);

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({ error: "plain_account_requires_settings_v2" });
    });

    it("POST /v2/account/settings rejects encrypted content for plain accounts", async () => {
        txAccountFindUnique = vi.fn(async () => ({
            settings: null,
            settingsVersion: 0,
            publicKey: null,
            encryptionMode: "plain",
        }));
        txAccountUpdateMany = vi.fn(async () => ({ count: 1 }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v2/account/settings");
        const reply = createReplyStub();

        const response = await handler(
            { userId: "u1", body: { content: { t: "encrypted", c: "ciphertext" }, expectedVersion: 0 } },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({ error: "invalid-params" });
        expect(txAccountUpdateMany).not.toHaveBeenCalled();
    });

    it("POST /v2/account/settings rejects plain content for e2ee accounts", async () => {
        txAccountFindUnique = vi.fn(async () => ({
            settings: "ciphertext",
            settingsVersion: 1,
            publicKey: "pk",
            encryptionMode: "e2ee",
        }));
        txAccountUpdateMany = vi.fn(async () => ({ count: 1 }));

        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const handler = getRouteHandler(app, "POST", "/v2/account/settings");
        const reply = createReplyStub();

        const response = await handler(
            { userId: "u1", body: { content: { t: "plain", v: {} }, expectedVersion: 1 } },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({ error: "invalid-params" });
        expect(txAccountUpdateMany).not.toHaveBeenCalled();
    });
});
