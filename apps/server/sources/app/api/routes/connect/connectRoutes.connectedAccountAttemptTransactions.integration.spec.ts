import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import {
    registerConnectedAccountAttemptTransactionRoutes,
} from "./connectedAccountAttemptTransactions/registerConnectedAccountAttemptTransactionRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });
    registerConnectedAccountAttemptTransactionRoutes(typed);
    return trackApp(typed);
}

describe("Connected Account attempt transaction routes", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-connected-account-attempt-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.repeatKey.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    it("stores only opaque ciphertext and isolates exact attempts by account", async () => {
        const [accountA, accountB] = await Promise.all([
            db.account.create({ data: { publicKey: "account-a" }, select: { id: true } }),
            db.account.create({ data: { publicKey: "account-b" }, select: { id: true } }),
        ]);
        const app = createTestApp();
        await app.ready();
        const expiresAtMs = Date.now() + 15 * 60_000;
        const ciphertext = "opaque-ciphertext-without-readable-provider-state";
        const url = "/v2/connect/connected-account-attempt-transactions/oauth/attempt_01HZX4T3Q7";

        const created = await app.inject({
            method: "POST",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": accountA.id,
            },
            payload: { ciphertext, expiresAtMs },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            revision: 1,
            ciphertext,
            expiresAtMs,
        });

        const rows = await db.repeatKey.findMany();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.key).not.toContain(accountA.id);
        expect(rows[0]?.key).not.toContain("attempt_01HZX4T3Q7");
        expect(rows[0]?.value).toContain(ciphertext);
        expect(rows[0]?.value).not.toContain("stagedCredentials");
        expect(rows[0]?.value).not.toContain("pkceVerifier");

        const sameAccount = await app.inject({
            method: "GET",
            url,
            headers: { "x-test-user-id": accountA.id },
        });
        expect(sameAccount.statusCode).toBe(200);
        expect(sameAccount.json()).toEqual(created.json());

        const crossAccount = await app.inject({
            method: "GET",
            url,
            headers: { "x-test-user-id": accountB.id },
        });
        expect(crossAccount.statusCode).toBe(404);
        expect(crossAccount.json()).toEqual({
            error: "connected_account_attempt_transaction_not_found",
        });
    });

    it("replaces and deletes only the exact current revision", async () => {
        const account = await db.account.create({
            data: { publicKey: "account-cas" },
            select: { id: true },
        });
        const app = createTestApp();
        await app.ready();
        const url = "/v2/connect/connected-account-attempt-transactions/device/device-attempt-1";
        const firstExpiry = Date.now() + 15 * 60_000;
        const secondExpiry = firstExpiry + 1_000;
        await app.inject({
            method: "POST",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: { ciphertext: "opaque-first", expiresAtMs: firstExpiry },
        });

        const replaced = await app.inject({
            method: "PATCH",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                expectedRevision: 1,
                ciphertext: "opaque-second",
                expiresAtMs: secondExpiry,
            },
        });
        expect(replaced.statusCode).toBe(200);
        expect(replaced.json()).toEqual({
            revision: 2,
            ciphertext: "opaque-second",
            expiresAtMs: secondExpiry,
        });

        const staleReplace = await app.inject({
            method: "PATCH",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                expectedRevision: 1,
                ciphertext: "opaque-stale",
                expiresAtMs: secondExpiry,
            },
        });
        expect(staleReplace.statusCode).toBe(409);
        expect(staleReplace.json()).toEqual({
            error: "connected_account_attempt_transaction_conflict",
        });

        const staleDelete = await app.inject({
            method: "DELETE",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: { expectedRevision: 1 },
        });
        expect(staleDelete.statusCode).toBe(409);

        const deleted = await app.inject({
            method: "DELETE",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: { expectedRevision: 2 },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ status: "deleted" });
        expect((await app.inject({
            method: "GET",
            url,
            headers: { "x-test-user-id": account.id },
        })).statusCode).toBe(404);
    });

    it("rejects traversal, oversized opaque payloads, and plaintext-bearing bodies", async () => {
        const account = await db.account.create({
            data: { publicKey: "account-invalid" },
            select: { id: true },
        });
        const app = createTestApp();
        await app.ready();
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": account.id,
        };
        const invalidAttempt = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/oauth/%2E%2E%2Fall",
            headers,
            payload: {
                ciphertext: "opaque",
                expiresAtMs: Date.now() + 60_000,
            },
        });
        expect(invalidAttempt.statusCode).toBe(400);

        const plaintext = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/oauth/attempt-1",
            headers,
            payload: {
                ciphertext: "opaque",
                expiresAtMs: Date.now() + 60_000,
                stagedCredentials: { token: "plaintext-secret" },
            },
        });
        expect(plaintext.statusCode).toBe(400);

        const oversized = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/oauth/attempt-2",
            headers,
            payload: {
                ciphertext: "x".repeat(524_289),
                expiresAtMs: Date.now() + 60_000,
            },
        });
        expect(oversized.statusCode).toBe(400);
        expect(await db.repeatKey.count()).toBe(0);
    });
});
