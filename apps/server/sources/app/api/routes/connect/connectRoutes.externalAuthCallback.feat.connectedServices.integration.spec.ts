import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";


function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
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
    });

    afterAll(async () => {
        await harness.close();
        globalThis.fetch = originalFetch;
    });

    it("creates a pending auth record and redirects without creating an account", async () => {
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

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");
        expect(redirect.searchParams.get("flow")).toBe("auth");
        const pending = redirect.searchParams.get("pending");
        expect(pending).toBeTruthy();

        const pendingRow = await db.repeatKey.findUnique({ where: { key: pending as string } });
        expect(pendingRow).toBeTruthy();
        // Pending record must not store the raw GitHub profile JSON.
        expect(pendingRow!.value.includes("avatar_url")).toBe(false);
        expect(pendingRow!.value.includes("Octo Cat")).toBe(false);

        const accounts = await db.account.findMany();
        expect(accounts.length).toBe(0);

        await app.close();
    });

    it("redirects back to the requesting web origin when the auth params request includes a loopback Origin header", async () => {
        applyGithubExternalAuthCallbackEnv(harness);

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

        const origin = "http://localhost:19081";
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
        expect(redirect.origin + redirect.pathname).toBe(`${origin}/oauth/github`);
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

    it("redirects with an oauth error when the user denies access (no code)", async () => {
        applyGithubExternalAuthCallbackEnv(harness);

        const seed = new Uint8Array(32).fill(9);
        const kp = tweetnacl.sign.keyPair.fromSeed(seed);
        const publicKey = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));

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
            url: `/v1/oauth/github/callback?error=access_denied&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        const redirect = new URL(res.headers.location as string);
        expect(redirect.origin + redirect.pathname).toBe("https://app.example.test/oauth/github");
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
