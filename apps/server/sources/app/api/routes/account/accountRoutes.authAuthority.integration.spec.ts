import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { buildAccountStoredContentCompatibilityHttpHeadersV1 } from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { accountRoutes } from "./accountRoutes";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    accountRoutes(typed);
    return typed;
}

describe("accountRoutes (direct-route auth authority) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-route-authority-",
            initAuth: true,
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.accountEncryptionTransitionCollectionStage.deleteMany();
        await db.accountEncryptionTransition.deleteMany();
        await db.accountSettingsSnapshot.deleteMany();
        await db.accountChange.deleteMany();
        await db.repeatKey.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("allows an interactive signed session to update Settings but refuses a PAT before the direct write", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const [signedToken, pat] = await Promise.all([
            auth.createToken(account.id),
            auth.createApiToken({
                accountId: account.id,
                label: "Settings automation regression",
            }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const interactiveWrite = await app.inject({
                method: "POST",
                url: "/v2/account/settings",
                headers: {
                    authorization: `Bearer ${signedToken}`,
                    "content-type": "application/json",
                },
                payload: {
                    content: { t: "plain", v: { schemaVersion: 2 } },
                    expectedVersion: 0,
                },
            });
            expect(interactiveWrite.statusCode).toBe(200);
            expect(interactiveWrite.json()).toEqual({ success: true, version: 1 });

            const automationWrite = await app.inject({
                method: "POST",
                url: "/v2/account/settings",
                headers: {
                    authorization: `Bearer ${pat.token}`,
                    "content-type": "application/json",
                },
                payload: {
                    content: { t: "plain", v: { schemaVersion: 3 } },
                    expectedVersion: 1,
                },
            });

            expect(automationWrite.statusCode).toBe(403);
            expect(automationWrite.json()).toEqual({ error: "present_user_required" });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { settingsVersion: true },
            })).resolves.toEqual({ settingsVersion: 1 });
        } finally {
            await app.close();
        }
    });

    it("refuses a PAT before an encryption migration control operation", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            label: "Encryption migration regression",
        });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate/transition/prepare",
                headers: {
                    authorization: `Bearer ${pat.token}`,
                    "content-type": "application/json",
                    ...buildAccountStoredContentCompatibilityHttpHeadersV1({
                        v: 1,
                        protocolVersion: 5,
                    }),
                },
                payload: {
                    toMode: "e2ee",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint: null,
                    expectedContentKeyFingerprint: null,
                },
            });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "present_user_required" });
            await expect(db.accountEncryptionTransition.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("denies a PAT from legacy direct reads while missing and invalid credentials still use authentication refusal", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            label: "Read-only automation",
        });
        const app = createTestApp();
        await app.ready();

        try {
            const [automationRead, missingCredential, invalidCredential] = await Promise.all([
                app.inject({
                    method: "GET",
                    url: "/v1/account/encryption",
                    headers: { authorization: `Bearer ${pat.token}` },
                }),
                app.inject({ method: "GET", url: "/v1/account/encryption" }),
                app.inject({
                    method: "GET",
                    url: "/v1/account/encryption",
                    headers: { authorization: "Bearer not-a-real-token" },
                }),
            ]);

            expect(automationRead.statusCode).toBe(403);
            expect(automationRead.json()).toEqual({ error: "present_user_required" });
            expect(missingCredential.statusCode).toBe(401);
            expect(missingCredential.json()).toEqual({ error: "Missing authorization header" });
            expect(invalidCredential.statusCode).toBe(401);
            expect(invalidCredential.json()).toEqual({ error: "invalid_token" });
        } finally {
            await app.close();
        }
    });
});
