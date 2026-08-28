import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1 } from "@happier-dev/protocol";

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

function createParserOrderingTestApp(parse: () => void) {
    const app = Fastify({ logger: false });
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (_request, body, done) => {
            parse();
            done(null, { token: body });
        },
    );
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    authRoutes(typed);
    return typed;
}

describe("authRoutes (API token introspection) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-api-token-introspection-",
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

    it("introspects a PAT through the canonical verifier for the authenticated daemon Account without exposing its secret", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-introspection-owner" },
            select: { id: true },
        });
        const daemonConnectionToken = await auth.createToken(account.id);
        const pat = await auth.createApiToken({
            accountId: account.id,
            label: "Daemon Action API",
            expiresAt: new Date("2030-08-22T12:01:00.000Z"),
        });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                headers: { authorization: `Bearer ${daemonConnectionToken}` },
                payload: { token: pat.token },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                accountId: account.id,
                principalId: account.id,
                credentialId: pat.tokenId,
                expiresAt: "2030-08-22T12:01:00.000Z",
                authority: "account_automation",
            });
            const patSecret = pat.token.split("_")[3];
            expect(patSecret).toBeTruthy();
            expect(response.body).not.toContain(pat.token);
            expect(response.body).not.toContain(patSecret!);
        } finally {
            await app.close();
        }
    });

    it("rejects a verified PAT for a different daemon-bound Account with the opaque invalid-token result", async () => {
        const [owner, other] = await Promise.all([
            db.account.create({ data: { publicKey: "api-token-introspection-owner-a" }, select: { id: true } }),
            db.account.create({ data: { publicKey: "api-token-introspection-owner-b" }, select: { id: true } }),
        ]);
        const [otherDaemonConnectionToken, pat] = await Promise.all([
            auth.createToken(other.id),
            auth.createApiToken({ accountId: owner.id, label: "Other Account" }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                headers: { authorization: `Bearer ${otherDaemonConnectionToken}` },
                payload: { token: pat.token },
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "invalid_token" });
        } finally {
            await app.close();
        }
    });

    it("does not accept a caller-supplied Account claim in the PAT body", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-introspection-no-body-account" },
            select: { id: true },
        });
        const [daemonConnectionToken, pat] = await Promise.all([
            auth.createToken(account.id),
            auth.createApiToken({ accountId: account.id, label: "No body Account" }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const [extraFieldResponse, nonStringResponse] = await Promise.all([
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                    headers: { authorization: `Bearer ${daemonConnectionToken}` },
                    payload: { token: pat.token, accountId: "caller-claimed-account" },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                    headers: { authorization: `Bearer ${daemonConnectionToken}` },
                    payload: { token: 42 },
                }),
            ]);

            expect(extraFieldResponse.statusCode).toBe(400);
            expect(nonStringResponse.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });

    it("does not cross-honor a PAT as the daemon connection credential or a signed token as the introspected PAT", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-introspection-cross-honor" },
            select: { id: true },
        });
        const [daemonConnectionToken, pat] = await Promise.all([
            auth.createToken(account.id),
            auth.createApiToken({ accountId: account.id, label: "Cross-honor guard" }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const [patCaller, signedTokenBody, controlHeaderCaller] = await Promise.all([
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                    headers: { authorization: `Bearer ${pat.token}` },
                    payload: { token: pat.token },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                    headers: { authorization: `Bearer ${daemonConnectionToken}` },
                    payload: { token: daemonConnectionToken },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                    headers: { "x-happier-daemon-token": "local-control-token" },
                    payload: { token: pat.token },
                }),
            ]);

            expect(patCaller.statusCode).toBe(403);
            expect(patCaller.json()).toEqual({ error: "present_user_required" });
            expect(signedTokenBody.statusCode).toBe(401);
            expect(signedTokenBody.json()).toEqual({ error: "invalid_token" });
            expect(controlHeaderCaller.statusCode).toBe(401);
            expect(controlHeaderCaller.json()).toEqual({ error: "Missing authorization header" });
        } finally {
            await app.close();
        }
    });

    it("keeps rejected daemon connection authentication distinct from an authenticated invalid PAT", async () => {
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                headers: { authorization: "Bearer rejected-daemon-connection-token" },
                payload: { token: "invalid-subject-pat" },
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "authentication_failed" });
        } finally {
            await app.close();
        }
    });

    it("rejects the daemon connection in onRequest before parsing the introspected PAT body", async () => {
        const parse = vi.fn();
        const app = createParserOrderingTestApp(parse);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                headers: {
                    authorization: "Bearer rejected-daemon-connection-token",
                    "content-type": "application/json",
                },
                payload: "{not-json",
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "authentication_failed" });
            expect(parse).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("reflects revocation through the canonical verifier on the next introspection", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-introspection-revocation" },
            select: { id: true },
        });
        const daemonConnectionToken = await auth.createToken(account.id);
        const pat = await auth.createApiToken({ accountId: account.id, label: "Revocable daemon token" });
        await auth.revokeApiToken({ accountId: account.id, tokenId: pat.tokenId });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
                headers: { authorization: `Bearer ${daemonConnectionToken}` },
                payload: { token: pat.token },
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "invalid_token" });
        } finally {
            await app.close();
        }
    });
});
