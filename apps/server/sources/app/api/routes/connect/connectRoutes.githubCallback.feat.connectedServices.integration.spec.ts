import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

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

    return trackApp(typed);
}

function applyGithubConnectCallbackEnv(
    harness: LightSqliteHarness,
    overrides: Record<string, string | undefined> = {},
): void {
    harness.resetEnv({
        GITHUB_CLIENT_ID: "gh_client",
        GITHUB_CLIENT_SECRET: "gh_secret",
        GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
        HAPPIER_WEBAPP_URL: "https://app.example.test",
        ...overrides,
    });
}

describe("connectRoutes (GitHub callback)", () => {
    const originalFetch = globalThis.fetch;
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connect-gh-callback-",
            initAuth: true,
        });
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
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

    it("redirects with invalid_profile when the provider /user response is missing required fields", async () => {
        applyGithubConnectCallbackEnv(harness);

        const u1 = await db.account.create({
            data: { publicKey: "pk-u1", username: "user1" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ({ login: "octocat" }) } as any; // missing required fields
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("https://app.example.test/oauth/github?flow=connect&error=invalid_profile");

        await app.close();
    });

    it("returns 404 not_found for /v1/connect/external/:provider/params when connected services are disabled", async () => {
        applyGithubConnectCallbackEnv(harness, {
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0",
            HAPPIER_WEBAPP_URL: undefined,
        });

        const u1 = await db.account.create({
            data: { publicKey: "pk-u1-disabled", username: "user_disabled" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });
        expect(paramsRes.statusCode).toBe(404);
        expect(paramsRes.json()).toEqual({ error: "not_found" });

        await app.close();
    });

    it("rejects connect-flow callbacks when connected services are disabled (in-flight flow)", async () => {
        applyGithubConnectCallbackEnv(harness);

        const u1 = await db.account.create({
            data: { publicKey: "pk-u1-connect-disabled", username: "user_connect_disabled" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        applyGithubConnectCallbackEnv(harness, { HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: "0" });

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return {
                    ok: true,
                    json: async () => ({
                        id: 1,
                        login: "octocat",
                        avatar_url: "x",
                        name: null,
                    }),
                } as any;
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("https://app.example.test/oauth/github?flow=connect&error=connect_disabled");

        await app.close();
    });

    it("uses HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE when redirecting back to the client", async () => {
        applyGithubConnectCallbackEnv(harness, {
            HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: "https://app.example.test/custom-oauth",
            HAPPIER_WEBAPP_URL: undefined,
        });

        const u1 = await db.account.create({
            data: { publicKey: "pk-u1", username: "user1" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const fetchMock = vi.fn(async (url: any) => {
            if (typeof url === "string" && url.includes("https://github.com/login/oauth/access_token")) {
                return { ok: true, json: async () => ({ access_token: "tok_1" }) } as any;
            }
            if (typeof url === "string" && url.includes("https://api.github.com/user")) {
                return { ok: true, json: async () => ({ login: "octocat" }) } as any; // missing required fields
            }
            throw new Error(`Unexpected fetch: ${String(url)}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=c1&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("https://app.example.test/custom-oauth/github?flow=connect&error=invalid_profile");

        await app.close();
    });

    it("GET /v1/connect/external/:provider/params returns an OAuth URL with least-privilege scope", async () => {
        applyGithubConnectCallbackEnv(harness, {
            GITHUB_CLIENT_ID: "client-id",
            GITHUB_CLIENT_SECRET: undefined,
            HAPPIER_WEBAPP_URL: undefined,
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-oauth-u1" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as { url: string };
        const url = new URL(body.url);
        expect(url.hostname).toBe("github.com");
        expect(url.pathname).toBe("/login/oauth/authorize");
        expect(url.searchParams.get("scope")).toBe("read:user");
        expect(url.searchParams.get("client_id")).toBe("client-id");
        expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.test/v1/oauth/github/callback");
        expect(url.searchParams.get("state")).toEqual(expect.any(String));
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toEqual(expect.any(String));

        const oauthState = await auth.verifyOauthStateToken(url.searchParams.get("state")!);
        expect(oauthState).toBeTruthy();
        expect(oauthState!.sid).toEqual(expect.any(String));
        const sid = oauthState!.sid;

        const stateRow = await db.repeatKey.findUnique({ where: { key: `oauth_state_${sid}` } });
        expect(stateRow).toBeTruthy();

        await app.close();
    });

    it("GET /v1/connect/external/:provider/params returns 400 when OAuth env is missing", async () => {
        applyGithubConnectCallbackEnv(harness, {
            GITHUB_CLIENT_ID: undefined,
            GITHUB_CLIENT_SECRET: undefined,
            GITHUB_REDIRECT_URL: undefined,
            GITHUB_REDIRECT_URI: undefined,
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-oauth-missing-u1" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "oauth_not_configured" });

        await app.close();
    });

    it("GET /v1/oauth/:provider/callback redirects with error=missing_access_token when code exchange returns no token", async () => {
        applyGithubConnectCallbackEnv(harness, {
            GITHUB_CLIENT_ID: "client-id",
            GITHUB_CLIENT_SECRET: "client-secret",
            HAPPIER_WEBAPP_URL: "https://webapp.example.test",
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-oauth-callback-u1" },
            select: { id: true },
        });

        const paramsRes = await app.inject({
            method: "GET",
            url: "/v1/connect/external/github/params",
            headers: { "x-test-user-id": u1.id },
        });
        expect(paramsRes.statusCode).toBe(200);
        const paramsUrl = new URL((paramsRes.json() as { url: string }).url);
        const state = paramsUrl.searchParams.get("state");
        expect(state).toBeTruthy();

        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes("github.com/login/oauth/access_token")) {
                return {
                    ok: true,
                    json: async () => ({}),
                };
            }
            throw new Error(`unexpected fetch: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock as any);

        const res = await app.inject({
            method: "GET",
            url: `/v1/oauth/github/callback?code=test-code&state=${encodeURIComponent(state!)}`,
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe(
            "https://webapp.example.test/oauth/github?flow=connect&error=missing_access_token",
        );

        await app.close();
    });
});
