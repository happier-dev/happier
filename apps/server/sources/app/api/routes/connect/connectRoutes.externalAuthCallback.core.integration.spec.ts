import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The GitHub endpoints and avatar host are faked through the global fetch stub below.
vi.mock("@/app/net/outboundIdentityFetch", () => import("@/testkit/outboundFetchViaGlobalFetch"));
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { createExternalAuthorizeAttempt } from "./oauthExternal/createExternalAuthorizeUrl";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";


function createTestApp() {
    const app = Fastify({ logger: false, trustProxy: true });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return typed;
}

function applyGithubExternalAuthCallbackEnv(
    harness: LightSqliteHarness,
    overrides: Record<string, string | undefined> = {},
): void {
    harness.resetEnv({
        GITHUB_CLIENT_ID: "gh_client",
        GITHUB_CLIENT_SECRET: "gh_secret",
        GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
        AUTH_SIGNUP_PROVIDERS: "github",
        HAPPIER_WEBAPP_URL: "https://app.example.test",
        ...overrides,
    });
}

describe("connectRoutes (GitHub callback) external auth flow (integration)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-external-callback-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);
    afterEach(async () => {
        harness.resetEnv();
        vi.unstubAllGlobals();
        globalThis.fetch = originalFetch;
        await db.repeatKey.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
        await db.homeGovernancePolicy.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
    });

    it("defers normal connect completion to the authenticated finalizer and adopts merged credential evidence", async () => {
        applyGithubExternalAuthCallbackEnv(harness);
        const account = await db.account.create({
            data: { publicKey: `pk-connect-adoption-${Date.now()}`, username: "account-owner" },
            select: { id: true },
        });
        const initiating = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        const terminal = await auth.createToken(account.id, { session: "terminal-connect-authority" }, {
            kind: "terminal",
            authority: "account_automation",
        });
        const profile = {
            id: 4815,
            login: "external-login",
            avatar_url: "https://avatars.example.test/external-login.png",
            name: "External Login",
        };
        vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "connect_tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => profile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();
        const deniedStart = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params?connectFinalization=credential_adoption_v1",
            headers: { authorization: `Bearer ${terminal}` },
        });
        expect(deniedStart.statusCode, deniedStart.body).toBe(403);
        expect(deniedStart.json()).toEqual({ error: "present_user_required" });
        expect(await db.repeatKey.count()).toBe(0);

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { authorization: `Bearer ${initiating}` },
        });
        expect(paramsRes.statusCode, paramsRes.body).toBe(200);
        const state = new URL((paramsRes.json() as { url: string }).url).searchParams.get("state");
        expect(state).toBeTruthy();

        const callback = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=connect-code&state=${encodeURIComponent(state!)}`,
        });
        expect(callback.statusCode).toBe(302);
        const redirect = new URL(callback.headers.location as string);
        expect(redirect.searchParams.get("error"), callback.headers.location).toBeNull();
        expect(redirect.searchParams.get("status")).toBe("connected");
        expect(redirect.searchParams.get("username")).toBe("account-owner");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toMatch(/^oauth_pending_/);
        expect(await db.accountIdentity.count({ where: { accountId: account.id } })).toBe(0);

        const deniedFinalize = await app.inject({
            method: "POST",
            url: "/v1/connect/external/github/finalize",
            headers: { authorization: `Bearer ${terminal}` },
            payload: { pending, username: "account-owner" },
        });
        expect(deniedFinalize.statusCode, deniedFinalize.body).toBe(403);
        expect(deniedFinalize.json()).toEqual({ error: "present_user_required" });
        expect(await db.repeatKey.findUnique({ where: { key: pending! } })).not.toBeNull();
        expect(await db.accountIdentity.count({ where: { accountId: account.id } })).toBe(0);

        const finalized = await app.inject({
            method: "POST",
            url: "/v1/connect/external/github/finalize",
            headers: { authorization: `Bearer ${initiating}` },
            payload: { pending, username: "account-owner" },
        });
        expect(finalized.statusCode, finalized.body).toBe(200);
        const replacementToken = (finalized.json() as { token: string }).token;
        const replacement = await auth.verifyToken(replacementToken);
        expect(replacement?.userId).toBe(account.id);
        expect(replacement?.authenticationEvidence).toEqual([
            { kind: "home_method", methodId: "key_challenge" },
            expect.objectContaining({
                kind: "provider",
                providerId: "github",
                identityId: expect.any(String),
                runtimeFingerprint: expect.any(String),
            }),
        ]);
        expect((await auth.verifyToken(initiating))?.authenticationEvidence).toEqual([
            { kind: "home_method", methodId: "key_challenge" },
        ]);

        const deniedDisconnect = await app.inject({
            method: "DELETE",
            url: "/v1/connect/external/github",
            headers: { authorization: `Bearer ${terminal}` },
        });
        expect(deniedDisconnect.statusCode, deniedDisconnect.body).toBe(403);
        expect(deniedDisconnect.json()).toEqual({ error: "present_user_required" });
        expect(await db.accountIdentity.count({ where: { accountId: account.id } })).toBe(1);

        const disconnected = await app.inject({
            method: "DELETE",
            url: "/v1/connect/external/github",
            headers: { authorization: `Bearer ${replacementToken}` },
        });
        expect(disconnected.statusCode, disconnected.body).toBe(200);
        expect(await db.accountIdentity.count({ where: { accountId: account.id } })).toBe(0);
        await app.close();
    });

    it("rejects a persisted connect attempt without adoption finalization before exchanging or linking", async () => {
        applyGithubExternalAuthCallbackEnv(harness);
        const account = await db.account.create({
            data: { publicKey: `pk-connect-legacy-${Date.now()}`, username: "legacy-owner" },
            select: { id: true },
        });
        const initiating = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "legacy_connect_tok" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ({ id: 4816, login: "legacy-external" }) } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        }));
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params?connectFinalization=credential_adoption_v1",
            headers: { authorization: `Bearer ${initiating}` },
        });
        const state = new URL((paramsRes.json() as { url: string }).url).searchParams.get("state");
        expect(state).toBeTruthy();
        const verifiedState = await auth.verifyOauthStateToken(state!);
        const attemptKey = `oauth_state_${verifiedState!.sid}`;
        const attempt = await db.repeatKey.findUniqueOrThrow({ where: { key: attemptKey } });
        const legacyAttempt = JSON.parse(attempt.value) as Record<string, unknown>;
        delete legacyAttempt.connectFinalization;
        await db.repeatKey.update({
            where: { key: attemptKey },
            data: { value: JSON.stringify(legacyAttempt) },
        });
        const callback = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=legacy-connect&state=${encodeURIComponent(state!)}`,
        });
        const redirect = new URL(callback.headers.location as string);
        expect(redirect.searchParams.get("error"), callback.headers.location).toBe("invalid_state");
        expect(redirect.searchParams.get("status")).toBeNull();
        expect(redirect.searchParams.get("pending")).toBeNull();
        expect(await db.repeatKey.count()).toBe(0);
        expect(await db.accountIdentity.count({ where: { accountId: account.id } })).toBe(0);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        await app.close();
    });

    it("atomically consumes an attempt and creates one pending auth record without creating an account", async () => {
        applyGithubExternalAuthCallbackEnv(harness);
        const seed = new Uint8Array(32).fill(1);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const responses = await Promise.all([0, 1].map(() => app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        })));
        const accepted = responses.filter((response) =>
            new URL(response.headers.location as string).searchParams.has("pending"));
        expect(accepted).toHaveLength(1);
        const rejected = responses.find((response) => response !== accepted[0])!;
        expect(new URL(rejected.headers.location as string).searchParams.get("error")).toBe("invalid_state");
        const res = accepted[0]!;

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");
        expect(redirect.searchParams.get("flow")).toBe("auth");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();
        expect(fetchMock.mock.calls.filter(([url]) =>
            String(url).includes("https://github.com/login/oauth/access_token"))).toHaveLength(1);
        // Pending record must not store the raw GitHub profile JSON.
        expect(pendingRow!.value.includes("avatar_url")).toBe(false);
        expect(pendingRow!.value.includes("Octo Cat")).toBe(false);

        const accounts = await db.account.findMany();
        expect(accounts.length).toBe(0);

        await app.close();
    });

    it.each([
        { origin: "http://localhost:19081", allowedSchemes: "", expectedBase: "http://localhost:19081/ui" },
        { origin: "http://tauri.localhost", allowedSchemes: "", expectedBase: "http://tauri.localhost" },
        { origin: "tauri://localhost", allowedSchemes: "tauri", expectedBase: "tauri://localhost" },
        { origin: "tauri://localhost", allowedSchemes: "", expectedBase: "tauri://localhost" },
        { origin: "tauri://evil.example.test", allowedSchemes: "tauri", expectedBase: "https://app.example.test" },
    ])("returns OAuth from $origin to $expectedBase with allowed schemes '$allowedSchemes'", async ({ origin, allowedSchemes, expectedBase }) => {
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_SERVER_UI_DIR: "/tmp/ui",
            HAPPIER_SERVER_UI_PREFIX: "/ui",
            HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: allowedSchemes,
        });

        const seed = new Uint8Array(32).fill(2);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
            headers: { origin },
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        // Custom-scheme URL.origin is "null"; check the actual Location authority and path.
        expect(`${redirect.protocol}//${redirect.host}${redirect.pathname}`).toBe(`${expectedBase}/oauth/github`);
        expect(redirect.searchParams.get("flow")).toBe("auth");
        expect(redirect.searchParams.get("pending")).toBeTruthy();

        await app.close();
    });

    it("creates a pending auth record for proofHash auth-start and includes provisioning hints in the redirect", async () => {
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const proofHash = "a".repeat(64);
        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?proofHash=${encodeURIComponent(proofHash)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");
        expect(redirect.searchParams.get("flow")).toBe("auth");
        expect(redirect.searchParams.get("pending")).toBeTruthy();
        expect(redirect.searchParams.get("provisioning")).toBe("required");
        expect(redirect.searchParams.get("storagePolicy")).toBe("optional");
        expect(redirect.searchParams.get("provisioningModes")).toBe("plain,e2ee");

        const pending = redirect.searchParams.get("pending") as string;
        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending } });
        expect(pendingRow).toBeTruthy();
        expect(pendingRow!.value.includes("avatar_url")).toBe(false);
        expect(pendingRow!.value.includes("Octo Cat")).toBe(false);

        const accounts = await db.account.findMany();
        expect(accounts.length).toBe(0);

        await app.close();
    });

    it("refuses a provider removed by the current Home authentication policy before code exchange", async () => {
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
        });
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?proofHash=${"c".repeat(64)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const state = new URL((paramsRes.json() as { url: string }).url).searchParams.get("state");
        expect(state).toBeTruthy();
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                revision: 1,
                authenticationPolicy: { v: 1, enabledMethodIds: ["email"] },
            },
        });
        const network = vi.fn();
        vi.stubGlobal("fetch", network);

        const response = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=denied-by-home&state=${encodeURIComponent(state!)}`,
        });
        expect(response.statusCode).toBe(302);
        expect(new URL(response.headers.location as string).searchParams.get("error")).toBe("keyless_disabled");
        expect(network).not.toHaveBeenCalled();
        await app.close();
    });

    it("returns one-time bounded evidence for an identity-connection test without linking or authenticating", async () => {
        applyGithubExternalAuthCallbackEnv(harness);
        const resolved = await resolveOAuthRuntimeById(process.env, "github");
        expect(resolved).not.toBeNull();
        const attempt = await createExternalAuthorizeAttempt({
            flow: "connect",
            env: process.env,
            providerId: "github",
            provider: resolved!.provider,
            reference: resolved!.reference,
            userId: "initiating-admin",
            purpose: "identity_connection_test",
            webAppOAuthReturnUrl: "https://app.example.test/settings/authentication",
        });
        expect(attempt).not.toBeNull();
        const state = new URL(attempt!.url).searchParams.get("state");
        expect(state).toBeTruthy();

        const fetchMock = vi.fn(async (url: unknown) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "test-only-token" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return {
                    ok: true,
                    json: async () => ({ id: 314, login: "test-subject", name: "Test Subject" }),
                } as any;
            }
            throw new Error(`unexpected URL: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=test-code&state=${encodeURIComponent(state!)}`,
        });
        expect(response.statusCode).toBe(302);
        const redirect = new URL(response.headers.location as string);
        expect(redirect.searchParams.get("purpose")).toBe("identity_connection_test");
        expect(redirect.searchParams.get("error")).toBeNull();
        const resultHandle = redirect.searchParams.get("resultHandle");
        expect(resultHandle).toBeTruthy();
        const stored = await db.repeatKey.findUnique({
            where: { key: `oauth_identity_connection_test_result_${resultHandle}` },
        });
        expect(stored).toBeTruthy();
        expect(stored!.value).not.toContain("test-only-token");
        expect(stored!.value).not.toContain("Test Subject");
        expect(await db.account.count()).toBe(0);
        expect(await db.accountIdentity.count()).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await app.close();
    });

    it("binds the account_directory purpose and exact Account Service target through signed state, pending storage, and callback redirect", async () => {
        const endpointUrl = "https://accounts.example.test";
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_PUBLIC_SERVER_URL: endpointUrl,
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
        const endpointServerIdentityId = await getOrCreateServerIdentityId(process.env);
        const proofHash = "d".repeat(64);
        const ghProfile = {
            id: 987,
            login: "directory-user",
            avatar_url: "https://avatars.example.test/directory-user.png",
            name: "Directory User",
        };
        const fetchMock = vi.fn(async (url: unknown) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "directory_tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const query = new URLSearchParams({
            mode: "keyless",
            proofHash,
            purpose: "account_directory",
            endpointUrl,
            endpointServerIdentityId,
            canonicalServerUrl: endpointUrl,
        });
        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?${query.toString()}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsBody = paramsRes.json() as {
            url: string;
            purpose: string;
            credentialTarget: string;
            endpointUrl: string;
            endpointServerIdentityId: string;
            canonicalServerUrl: string;
            expiresAt: string;
        };
        expect(paramsBody).toMatchObject({
            purpose: "account_directory",
            credentialTarget: "account_directory",
            endpointUrl,
            endpointServerIdentityId,
            canonicalServerUrl: endpointUrl,
        });
        expect(Date.parse(paramsBody.expiresAt)).toBeGreaterThan(Date.now());
        const authorizeUrl = new URL(paramsBody.url);
        const state = authorizeUrl.searchParams.get("state");
        expect(state).toBeTruthy();
        expect(await auth.verifyOauthStateToken(state!)).toMatchObject({
            flow: "auth",
            provider: "github",
            purpose: "account_directory",
            endpointUrl,
            endpointServerIdentityId,
            canonicalServerUrl: endpointUrl,
        });

        const callbackRes = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=directory-code&state=${encodeURIComponent(state!)}`,
        });
        expect(callbackRes.statusCode).toBe(302);
        const redirect = new URL(callbackRes.headers.location as string);
        expect(redirect.searchParams.get("flow")).toBe("auth");
        expect(redirect.searchParams.get("purpose")).toBe("account_directory");
        expect(redirect.searchParams.get("credentialTarget")).toBe("account_directory");
        expect(redirect.searchParams.get("endpointUrl")).toBe(endpointUrl);
        expect(redirect.searchParams.get("endpointServerIdentityId")).toBe(endpointServerIdentityId);
        expect(redirect.searchParams.get("canonicalServerUrl")).toBe(endpointUrl);
        const pendingKey = redirect.searchParams.get("pending");
        expect(pendingKey).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pendingKey! } });
        expect(JSON.parse(pendingRow!.value)).toMatchObject({
            v: 2,
            flow: "auth",
            authMode: "keyless",
            provider: "github",
            purpose: "account_directory",
            endpointUrl,
            endpointServerIdentityId,
            canonicalServerUrl: endpointUrl,
            proofHash,
        });
        expect(await db.account.count()).toBe(0);

        await app.close();
    });

    it("filters public provisioning modes in the OAuth callback redirect", async () => {
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "github",
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "keyless",
        });

        const ghProfile = {
            id: 321,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_2" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const proofHash = "b".repeat(64);
        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?proofHash=${encodeURIComponent(proofHash)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c2&state=${encodeURIComponent(state!)}`,
            headers: { "x-forwarded-for": "203.0.113.10" },
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.searchParams.get("provisioningModes")).toBe("e2ee");

        await app.close();
    });

    it.each([
        { origin: "https://app.example.test", expectedBase: "https://app.example.test" },
        { origin: "tauri://localhost", expectedBase: "tauri://localhost" },
    ])("returns cancellation to $expectedBase without creating pending credentials", async ({ origin, expectedBase }) => {
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_SERVER_UI_DIR: "/tmp/ui",
            HAPPIER_SERVER_UI_PREFIX: "/ui",
        });

        const seed = new Uint8Array(32).fill(9);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
            headers: { origin },
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?error=access_denied&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(`${redirect.protocol}//${redirect.host}${redirect.pathname}`).toBe(`${expectedBase}/oauth/github`);
        expect(redirect.searchParams.get("flow")).toBe("auth");
        expect(redirect.searchParams.get("error")).toBe("access_denied");
        expect(redirect.searchParams.get("pending")).toBeNull();

        const pendingRows = await db.repeatKey.findMany({
            where: { key: { startsWith: "oauth_pending_" } },
        });
        expect(pendingRows.length).toBe(0);

        await app.close();
    });

    it("redirects with invalid_state when state token is invalid (no server crash)", async () => {
        applyGithubExternalAuthCallbackEnv(harness);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v1/oauth/github/callback?code=c1&state=not-a-valid-state-token",
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");
        expect(redirect.searchParams.get("error")).toBe("invalid_state");

        await app.close();
    });

    it("does not allow an http webapp oauth return url even when http is allowlisted", async () => {
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: "http://evil.example.test/oauth",
            HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: "http",
        });

        const seed = new Uint8Array(32).fill(8);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        // must ignore http base and fall back to https HAPPIER_WEBAPP_URL
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");

        await app.close();
    });

    it("honors legacy GITHUB_OAUTH_PENDING_TTL_SECONDS when OAUTH_PENDING_TTL_SECONDS is unset", async () => {
        applyGithubExternalAuthCallbackEnv(harness, {
            OAUTH_PENDING_TTL_SECONDS: undefined,
            GITHUB_OAUTH_PENDING_TTL_SECONDS: "120",
        });

        const seed = new Uint8Array(32).fill(3);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const startedAt = Date.now();
        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });
        expect(res.statusCode).toBe(302);

        const redirect = new URL(res.headers.location as string);
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();
        const ttlMs = pendingRow!.expiresAt.getTime() - startedAt;
        expect(ttlMs).toBeGreaterThanOrEqual(110_000);
        expect(ttlMs).toBeLessThanOrEqual(140_000);

        await app.close();
    });

    it("ignores an unsafe HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE and falls back to HAPPIER_WEBAPP_URL", async () => {
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: "javascript:alert(1)",
        });

        const seed = new Uint8Array(32).fill(9);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");

        await app.close();
    });

    it("allows a custom OAuth return scheme when explicitly allowlisted", async () => {
        applyGithubExternalAuthCallbackEnv(harness, {
            HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: "myapp://oauth",
            HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: "myapp",
        });

        const seed = new Uint8Array(32).fill(8);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        expect((res.headers.location as string).startsWith("myapp://oauth/github?")).toBe(true);

        await app.close();
    });

    it("redirects with github=username_required when the GitHub login is already taken", async () => {
        applyGithubExternalAuthCallbackEnv(harness);

        await db.account.create({
            data: {
                publicKey: "pk_dummy_1",
                username: "octocat",
            },
        });

        const seed = new Uint8Array(32).fill(2);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");
        expect(redirect.searchParams.get("flow")).toBe("auth");
        expect(redirect.searchParams.get("status")).toBe("username_required");
        expect(redirect.searchParams.get("reason")).toBe("login_taken");
        expect(redirect.searchParams.get("login")).toBe("octocat");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();

        const accounts = await db.account.findMany();
        expect(accounts.length).toBe(1);

        await app.close();
    });

    it("does not prompt for username when the GitHub identity is already linked (auth signup flows should restore instead)", async () => {
        applyGithubExternalAuthCallbackEnv(harness);

        const existing = await db.account.create({
            data: {
                publicKey: "pk_existing_1",
                username: "octocat",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: existing.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                showOnProfile: true,
            },
        });

        const seed = new Uint8Array(32).fill(3);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

        const ghProfile = {
            id: 123,
            login: "octocat",
            avatar_url: "https://avatars.example.test/octo.png",
            name: "Octo Cat",
        };

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ghProfile } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: `/v1/auth/external/github/params?publicKey=${encodeURIComponent(publicKey)}`,
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");
        expect(redirect.searchParams.get("flow")).toBe("auth");
        expect(redirect.searchParams.get("status")).toBeNull();
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();
        const pendingJson = JSON.parse(pendingRow!.value) as any;
        expect(pendingJson.usernameRequired).toBe(false);

        const accounts = await db.account.findMany();
        expect(accounts.length).toBe(1);

        await app.close();
    });
});
