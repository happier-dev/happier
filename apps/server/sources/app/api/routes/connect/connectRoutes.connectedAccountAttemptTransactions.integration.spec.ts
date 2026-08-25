import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import {
    registerConnectedAccountAttemptTransactionRoutes,
} from "./connectedAccountAttemptTransactions/registerConnectedAccountAttemptTransactionRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

async function createE2eeAccount(): Promise<Readonly<{ id: string }>> {
    return await db.account.create({
        data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
        select: { id: true },
    });
}

async function createPlainAccount(): Promise<Readonly<{ id: string }>> {
    return await db.account.create({
        data: { publicKey: null, encryptionMode: "plain" },
        select: { id: true },
    });
}

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

    it("stores only the opaque E2EE envelope and isolates exact attempts by account", async () => {
        const [accountA, accountB] = await Promise.all([
            createE2eeAccount(),
            createE2eeAccount(),
        ]);
        const app = createTestApp();
        await app.ready();
        const expiresAtMs = Date.now() + 15 * 60_000;
        const ciphertext = "opaque-ciphertext-without-readable-provider-state";
        const content = { t: "encrypted", c: ciphertext } as const;
        const url = "/v2/connect/connected-account-attempt-transactions/oauth/attempt_01HZX4T3Q7";

        const created = await app.inject({
            method: "POST",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": accountA.id,
            },
            payload: { content, expiresAtMs },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            revision: 1,
            content,
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
        const account = await createE2eeAccount();
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
            payload: {
                content: { t: "encrypted", c: "opaque-first" },
                expiresAtMs: firstExpiry,
            },
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
                content: { t: "encrypted", c: "opaque-second" },
                expiresAtMs: secondExpiry,
            },
        });
        expect(replaced.statusCode).toBe(200);
        expect(replaced.json()).toEqual({
            revision: 2,
            content: { t: "encrypted", c: "opaque-second" },
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
                content: { t: "encrypted", c: "opaque-stale" },
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
        const account = await createE2eeAccount();
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
                content: { t: "encrypted", c: "opaque" },
                expiresAtMs: Date.now() + 60_000,
            },
        });
        expect(invalidAttempt.statusCode).toBe(400);

        const plaintext = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/oauth/attempt-1",
            headers,
            payload: {
                content: { t: "encrypted", c: "opaque" },
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
                content: { t: "encrypted", c: "x".repeat(524_289) },
                expiresAtMs: Date.now() + 60_000,
            },
        });
        expect(oversized.statusCode).toBe(400);
        expect(await db.repeatKey.count()).toBe(0);
    });

    it("seals a plain Account's readable attempt payload at rest and reopens it", async () => {
        // A plain Account's envelope is the readable value, and an in-flight
        // authentication attempt carries the PKCE verifier and the staged provider
        // secrets. The same Account's settled credentials are sealed with the
        // server at-rest key, so its in-flight ones cannot sit in the database in
        // the clear.
        const account = await createPlainAccount();
        const app = createTestApp();
        await app.ready();
        const expiresAtMs = Date.now() + 15 * 60_000;
        const url =
            "/v2/connect/connected-account-attempt-transactions/oauth/plain-attempt";
        const verifier = "pkce-verifier-must-not-be-readable";
        const stagedSecret = "device-auth-secret-must-not-be-readable";
        const content = {
            t: "plain",
            v: {
                version: 1,
                kind: "oauth",
                verifier,
                stagedCredentials: { deviceAuthId: stagedSecret },
            },
        } as const;

        const created = await app.inject({
            method: "POST",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: { content, expiresAtMs },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({ revision: 1, content, expiresAtMs });

        const stored = await db.repeatKey.findMany();
        expect(stored).toHaveLength(1);
        expect(stored[0]?.value).not.toContain(verifier);
        expect(stored[0]?.value).not.toContain(stagedSecret);

        // Sealing is only useful if the exact envelope still comes back, through
        // the read path and through a later replace.
        const opened = await app.inject({
            method: "GET",
            url,
            headers: { "x-test-user-id": account.id },
        });
        expect(opened.statusCode).toBe(200);
        expect(opened.json()).toEqual({ revision: 1, content, expiresAtMs });

        const nextContent = {
            t: "plain",
            v: { version: 1, kind: "oauth", verifier, consumed: true },
        } as const;
        const replaced = await app.inject({
            method: "PATCH",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                expectedRevision: 1,
                content: nextContent,
                expiresAtMs,
            },
        });
        expect(replaced.statusCode).toBe(200);
        expect(replaced.json()).toEqual({
            revision: 2,
            content: nextContent,
            expiresAtMs,
        });
        const afterReplace = await db.repeatKey.findMany();
        expect(afterReplace[0]?.value).not.toContain(verifier);
    });

    it("admits each envelope kind against the persisted Account mode and refuses the other", async () => {
        const [plainAccount, e2eeAccount] = await Promise.all([
            createPlainAccount(),
            createE2eeAccount(),
        ]);
        const app = createTestApp();
        await app.ready();
        const expiresAtMs = Date.now() + 15 * 60_000;
        const plainUrl = "/v2/connect/connected-account-attempt-transactions/device/plain-attempt";
        const plainContent = { t: "plain", v: { version: 1, kind: "device" } } as const;

        const storedPlain = await app.inject({
            method: "POST",
            url: plainUrl,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": plainAccount.id,
            },
            payload: { content: plainContent, expiresAtMs },
        });
        expect(storedPlain.statusCode).toBe(200);
        expect(storedPlain.json()).toEqual({
            revision: 1,
            content: plainContent,
            expiresAtMs,
        });

        const plainAccountEncrypted = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/device/plain-mismatch",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": plainAccount.id,
            },
            payload: {
                content: { t: "encrypted", c: "opaque" },
                expiresAtMs,
            },
        });
        expect(plainAccountEncrypted.statusCode).toBe(409);
        expect(plainAccountEncrypted.json()).toEqual({
            error: "connected_account_attempt_transaction_storage_mode_mismatch",
        });

        const e2eeAccountPlain = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/device/e2ee-mismatch",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": e2eeAccount.id,
            },
            payload: { content: plainContent, expiresAtMs },
        });
        expect(e2eeAccountPlain.statusCode).toBe(409);
        expect(e2eeAccountPlain.json()).toEqual({
            error: "connected_account_attempt_transaction_storage_mode_mismatch",
        });

        // Only the mode-matching write is stored; neither refusal left a row behind.
        const rows = await db.repeatKey.findMany();
        expect(rows).toHaveLength(1);
    });
});
