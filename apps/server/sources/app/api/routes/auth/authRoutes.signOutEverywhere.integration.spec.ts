import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { authRoutes } from "./authRoutes";

const SIGN_OUT_EVERYWHERE_PATH = "/v1/auth/sessions/sign-out-everywhere";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    authRoutes(typed);
    return typed;
}

describe("authRoutes (sign out everywhere) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-sign-out-everywhere-",
            initAuth: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("bumps the authenticated Account epoch, immediately rejects its warmed signed token, and retains its API tokens", async () => {
        const account = await db.account.create({
            data: { publicKey: "sign-out-everywhere-owner" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);
        const pat = await auth.createApiToken({
            accountId: account.id,
            label: "Retained by sign out everywhere",
        });
        const app = createTestApp();
        await app.ready();

        try {
            const warmed = await app.inject({
                method: "GET",
                url: "/v1/auth/ping",
                headers: { authorization: `Bearer ${token}` },
            });
            expect(warmed.statusCode).toBe(200);

            const response = await app.inject({
                method: "POST",
                url: SIGN_OUT_EVERYWHERE_PATH,
                headers: { authorization: `Bearer ${token}` },
                payload: {},
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "signed_out" });

            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { tokenEpoch: true },
            })).resolves.toEqual({ tokenEpoch: 1 });

            const rejected = await app.inject({
                method: "GET",
                url: "/v1/auth/ping",
                headers: { authorization: `Bearer ${token}` },
            });
            expect(rejected.statusCode).toBe(401);

            await expect(auth.verifyToken(pat.token)).resolves.toMatchObject({
                userId: account.id,
                authTokenKind: "api_token",
                authority: "account_automation",
            });
        } finally {
            await app.close();
        }
    });

    it("does not let a PAT or caller-supplied Account id invoke sign out everywhere", async () => {
        const account = await db.account.create({
            data: { publicKey: "sign-out-everywhere-present-user" },
            select: { id: true },
        });
        const [signedToken, pat] = await Promise.all([
            auth.createToken(account.id),
            auth.createApiToken({ accountId: account.id, label: "Automation cannot sign out" }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const [automationResponse, retargetResponse] = await Promise.all([
                app.inject({
                    method: "POST",
                    url: SIGN_OUT_EVERYWHERE_PATH,
                    headers: { authorization: `Bearer ${pat.token}` },
                    payload: {},
                }),
                app.inject({
                    method: "POST",
                    url: SIGN_OUT_EVERYWHERE_PATH,
                    headers: { authorization: `Bearer ${signedToken}` },
                    payload: { accountId: "other-account" },
                }),
            ]);

            expect(automationResponse.statusCode).toBe(403);
            expect(automationResponse.json()).toEqual({ error: "present_user_required" });
            expect(retargetResponse.statusCode).toBe(400);
            expect(retargetResponse.json()).toEqual({ error: "invalid_request" });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { tokenEpoch: true },
            })).resolves.toEqual({ tokenEpoch: 0 });
        } finally {
            await app.close();
        }
    });
});
