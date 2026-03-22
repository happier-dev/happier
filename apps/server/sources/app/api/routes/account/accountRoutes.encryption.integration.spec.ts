import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

describe("accountRoutes (encryption mode integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-encryption-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.serviceAccountToken.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("GET /v1/account/encryption returns account encryption mode", async () => {
        const account = await db.account.create({
            data: {
                publicKey: "pk-account-encryption-get",
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt: new Date("2026-02-17T10:00:00.000Z"),
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "GET",
                    url: "/v1/account/encryption",
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ mode: "e2ee", updatedAt: 1771322400000 });
            },
        );
    });

    it("PATCH /v1/account/encryption returns 404 when account opt-out is disabled", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "0",
        });

        const account = await db.account.create({
            data: { publicKey: "pk-account-encryption-optout-disabled", encryptionMode: "e2ee" },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { mode: "plain" },
                });

                expect(res.statusCode).toBe(404);
                expect(res.json()).toEqual({ error: "not_found" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true },
        });
        expect(stored?.encryptionMode).toBe("e2ee");
    });

    it("PATCH /v1/account/encryption updates the account mode when account opt-out is enabled", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                publicKey: "pk-account-encryption-update",
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt: new Date("2026-02-17T10:00:00.000Z"),
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { mode: "plain" },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toMatchObject({ mode: "plain", updatedAt: expect.any(Number) });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, encryptionModeUpdatedAt: true },
        });
        expect(stored?.encryptionMode).toBe("plain");
        expect(stored?.encryptionModeUpdatedAt?.getTime()).toBeGreaterThan(1771322400000);
    });

    it("PATCH /v1/account/encryption rejects mode flips that require migration", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                publicKey: "pk-account-encryption-migration-required",
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt: new Date("2026-02-17T10:00:00.000Z"),
                settings: "cipher",
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "PATCH",
                    url: "/v1/account/encryption",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { mode: "plain" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "migration-required" });
            },
        );

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settings: true },
        });
        expect(stored?.encryptionMode).toBe("e2ee");
        expect(stored?.settings).toBe("cipher");
    });
});
