import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import {
    ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
} from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { authRoutes } from "./authRoutes";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    authRoutes(typed);
    return typed;
}

function bearer(token: string): Readonly<{ authorization: string }> {
    return { authorization: `Bearer ${token}` };
}

describe("authRoutes (API-token management) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-api-token-management-",
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

    it("creates a one-time bearer, permits terminal list only, and rejects PATs on every direct management route", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-management-owner" },
            select: { id: true },
        });
        const signedToken = await auth.createToken(account.id);
        const app = createTestApp();
        await app.ready();

        try {
            const created = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: { label: "CI deploy", expiresAt: "2030-08-22T12:00:00.000Z" },
            });

            expect(created.statusCode).toBe(200);
            const createdBody = created.json();
            expect(createdBody).toEqual({
                token: expect.stringMatching(/^hap_v1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u),
                apiToken: {
                    tokenId: expect.any(String),
                    label: "CI deploy",
                    displayPrefix: expect.stringMatching(/^hap_[0-9a-f]{8}$/u),
                    createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
                    lastUsedAt: null,
                    expiresAt: "2030-08-22T12:00:00.000Z",
                },
            });

            const signedList = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: {},
            });
            expect(signedList.statusCode).toBe(200);
            expect(signedList.json()).toEqual({ tokens: [createdBody.apiToken] });
            expect(signedList.body).not.toContain(createdBody.token);
            expect(signedList.body).not.toContain(createdBody.token.split("_")[3]);

            const [createWithPat, listWithPat, revokeWithPat, revokeAllWithPat] = await Promise.all([
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                    headers: bearer(createdBody.token),
                    payload: { label: "forbidden replacement" },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                    headers: bearer(createdBody.token),
                    payload: {},
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
                    headers: bearer(createdBody.token),
                    payload: { tokenId: createdBody.apiToken.tokenId },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
                    headers: bearer(createdBody.token),
                    payload: {},
                }),
            ]);

            for (const response of [createWithPat, listWithPat, revokeWithPat, revokeAllWithPat]) {
                expect(response.statusCode).toBe(403);
                expect(response.json()).toEqual({ error: "present_user_required" });
            }

            const terminalToken = await auth.createToken(account.id, { session: "api-token-management-terminal" });
            const terminalList = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                headers: bearer(terminalToken),
                payload: {},
            });
            expect(terminalList.statusCode).toBe(200);
            expect(terminalList.json()).toEqual({
                tokens: [{
                    ...createdBody.apiToken,
                    // Authentication must inspect a PAT before the shared
                    // direct-route deny applies, so the denied attempt can
                    // legitimately advance this activity projection.
                    lastUsedAt: expect.any(String),
                }],
            });

            const [createWithTerminal, revokeWithTerminal, revokeAllWithTerminal] = await Promise.all([
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                    headers: bearer(terminalToken),
                    payload: { label: "terminal replacement" },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
                    headers: bearer(terminalToken),
                    payload: { tokenId: createdBody.apiToken.tokenId },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
                    headers: bearer(terminalToken),
                    payload: {},
                }),
            ]);
            for (const response of [createWithTerminal, revokeWithTerminal, revokeAllWithTerminal]) {
                expect(response.statusCode).toBe(403);
                expect(response.json()).toEqual({ error: "present_user_required" });
            }
        } finally {
            await app.close();
        }
    });

    it("revokes a PAT through the current-Account route and rejects a past expiry as an invalid request", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-management-revocation" },
            select: { id: true },
        });
        const signedToken = await auth.createToken(account.id);
        const app = createTestApp();
        await app.ready();

        try {
            const created = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: { label: "Revocable" },
            });
            expect(created.statusCode).toBe(200);
            const createdBody = created.json();

            expect(await auth.verifyToken(createdBody.token)).toMatchObject({
                userId: account.id,
                authTokenKind: "api_token",
                authority: "account_automation",
            });

            const revoked = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: { tokenId: createdBody.apiToken.tokenId },
            });
            expect(revoked.statusCode).toBe(200);
            expect(revoked.json()).toEqual({ revoked: true });

            expect(await auth.verifyToken(createdBody.token)).toBeNull();

            const expired = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: { label: "already expired", expiresAt: "2020-08-22T12:00:00.000Z" },
            });
            expect(expired.statusCode).toBe(400);
            expect(expired.json()).toEqual({ error: "invalid_request" });
        } finally {
            await app.close();
        }
    });
});
