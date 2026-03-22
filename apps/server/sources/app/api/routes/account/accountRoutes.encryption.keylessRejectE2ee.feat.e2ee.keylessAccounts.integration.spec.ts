import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { registerAccountEncryptionRoutes } from "./registerAccountEncryptionRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

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

    return typed;
}

describe("registerAccountEncryptionRoutes (keyless accounts) (integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-encryption-keyless-",
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.accountIdentity.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("rejects switching to e2ee when the account is keyless (publicKey is null)", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountEncryptionRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/account/encryption",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { mode: "e2ee" },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params" });

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true },
        });
        expect(stored?.encryptionMode).toBe("plain");

        await app.close();
    });

    it("treats keyless accounts as plain on GET even if legacy rows store encryptionMode=e2ee", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "e2ee" },
            select: { id: true, encryptionModeUpdatedAt: true },
        });

        const app = createTestApp();
        registerAccountEncryptionRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v1/account/encryption",
            headers: { "x-test-user-id": account.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            mode: "plain",
            updatedAt: account.encryptionModeUpdatedAt.getTime(),
        });

        await app.close();
    });
});
