import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { enableAuthentication } from "../../utils/enableAuthentication";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    return typed;
}

function applyGithubExternalAuthParamsEnv(
    harness: LightSqliteHarness,
    overrides: Record<string, string | undefined> = {},
): void {
    harness.resetEnv({
        AUTH_SIGNUP_PROVIDERS: "github",
        GITHUB_CLIENT_ID: "gh_client",
        GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
        ...overrides,
    });
}

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


describe("connectRoutes (external auth params)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-external-params-",
            initAuth: true,
        });
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        await db.repeatKey.deleteMany().catch(() => {});
        harness.resetEnv();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("GET /v1/auth/external/github/params returns 200 with an OAuth URL when GitHub signup is enabled", async () => {
        applyGithubExternalAuthParamsEnv(harness);

        const seed = new Uint8Array(32).fill(1);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });

        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(typeof json.url).toBe("string");
        const url = new URL(json.url);
        expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
        expect(url.searchParams.get("client_id")).toBe("gh_client");
        expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.test/v1/oauth/github/callback");
        expect(url.searchParams.get("scope")).toBe("read:user");
        expect(url.searchParams.get("state")).toBeTruthy();
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toBeTruthy();

        await app.close();
    });

    it("GET /v1/auth/external/:provider/params returns 404 unsupported-provider for unknown providers", async () => {
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v1/auth/external/unknown/params?publicKey=abc",
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "unsupported-provider" });

        await app.close();
    });

    it("adds read:org scope when org allowlist is enabled and membership source is oauth_user_token", async () => {
        applyGithubExternalAuthParamsEnv(harness, {
            AUTH_GITHUB_ALLOWED_ORGS: "acme",
            AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: "oauth_user_token",
        });

        const seed = new Uint8Array(32).fill(2);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });

        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        const url = new URL(json.url);
        expect(url.searchParams.get("scope")).toBe("read:user read:org");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toBeTruthy();

        await app.close();
    });

    it("rejects keyless auth params when server storagePolicy=required_e2ee", async () => {
        applyGithubExternalAuthParamsEnv(harness, {
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            AUTH_SIGNUP_PROVIDERS: undefined,
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?mode=keyless&proofHash=${encodeURIComponent("a".repeat(64))}`,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "e2ee-required" });

        await app.close();
    });

    it("rejects keyless auth params when proofHash is not a sha256 hex string", async () => {
        applyGithubExternalAuthParamsEnv(harness, {
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            AUTH_SIGNUP_PROVIDERS: undefined,
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?mode=keyless&proofHash=${encodeURIComponent("not-hex")}`,
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "Invalid proof" });

        await app.close();
    });

    it("requires the current bearer and binds first-key step-up state to its Account and request digest", async () => {
        applyGithubExternalAuthParamsEnv(harness, {
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "provider-user-1",
                profile: {},
            },
        });
        const token = await auth.createToken(account.id);
        const proofHash = "c".repeat(64);
        const requestDigest = `aemrb1_${"A".repeat(43)}`;
        const url =
            `/v1/auth/external/github/params?mode=keyless`
            + `&proofHash=${proofHash}`
            + `&purpose=account_encryption_first_key`
            + `&requestDigest=${encodeURIComponent(requestDigest)}`;

        const app = createTestApp();
        enableAuthentication(app);
        connectRoutes(app);
        await app.ready();

        const missingBearer = await app.inject({ method: "GET", url });
        expect(missingBearer.statusCode).toBe(401);

        const response = await app.inject({
            method: "GET",
            url,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode, response.body).toBe(200);
        const authorizeUrl = new URL(response.json().url);
        const state = authorizeUrl.searchParams.get("state");
        expect(state).toBeTruthy();
        await expect(auth.verifyOauthStateToken(state!)).resolves.toMatchObject({
            flow: "auth",
            provider: "github",
            userId: account.id,
            proofHash,
            purpose: "account_encryption_first_key",
            requestDigest,
        });

        await db.account.update({
            where: { id: account.id },
            data: {
                contentPublicKey:
                    new Uint8Array(32).fill(7),
                contentPublicKeySig:
                    new Uint8Array(64).fill(8),
            },
        });
        const retainedKeyMaterial =
            await app.inject({
                method: "GET",
                url,
                headers: {
                    authorization:
                        `Bearer ${token}`,
                },
            });
        expect(
            retainedKeyMaterial.statusCode,
            retainedKeyMaterial.body,
        ).toBe(403);
        expect(retainedKeyMaterial.json()).toEqual({
            error: "step-up-not-eligible",
        });

        await app.close();
    });
});
