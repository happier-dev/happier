import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { startSocket } from "@/app/api/socket";
import type { Fastify as AppFastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { authRoutes } from "./authRoutes";

function createTestApp(): AppFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    startSocket(typed);
    authRoutes(typed);
    return typed;
}

describe("authRoutes (Account erasure) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-account-erasure-",
            initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "" },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => await harness.close());

    it("requires present-user authority and exact confirmation, then deletes only that Account", async () => {
        const account = await db.account.create({
            data: { publicKey: "account-erasure-admission", encryptionMode: "plain" },
        });
        await db.machine.create({
            data: { id: "account-erasure-machine", accountId: account.id, metadata: "fixture" },
        });
        const [signedToken, pat] = await Promise.all([
            auth.createToken(account.id),
            auth.createApiToken({ accountId: account.id, label: "Automation cannot erase Accounts" }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const patResponse = await app.inject({
                method: "POST",
                url: "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${pat.token}` },
                payload: { confirmation: "DELETE" },
            });
            expect(patResponse.statusCode).toBe(403);
            expect(patResponse.json()).toEqual({ error: "present_user_required" });

            const malformedResponse = await app.inject({
                method: "POST",
                url: "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${signedToken}` },
                payload: { confirmation: "delete", accountId: "another-account" },
            });
            expect(malformedResponse.statusCode).toBe(400);
            expect(malformedResponse.json()).toEqual({ error: "invalid_request" });
            await expect(db.account.findUnique({ where: { id: account.id } })).resolves.not.toBeNull();

            const deletedResponse = await app.inject({
                method: "POST",
                url: "/v1/auth/account/delete",
                headers: { authorization: `Bearer ${signedToken}` },
                payload: { confirmation: "DELETE" },
            });
            expect(deletedResponse.statusCode).toBe(200);
            expect(deletedResponse.json()).toEqual({ status: "deleted" });
            await expect(db.account.findUnique({ where: { id: account.id } })).resolves.toBeNull();
            await expect(db.machine.findUnique({ where: { id: "account-erasure-machine" } })).resolves.toBeNull();
        } finally {
            await app.close();
        }
    });
});
