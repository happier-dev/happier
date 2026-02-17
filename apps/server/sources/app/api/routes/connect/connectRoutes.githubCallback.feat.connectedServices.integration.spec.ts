import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function runServerPrismaMigrateDeploySqlite(params: { cwd: string; env: NodeJS.ProcessEnv }): void {
    const res = spawnSync(
        "yarn",
        ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"],
        {
            cwd: params.cwd,
            env: { ...(params.env as Record<string, string>), RUST_LOG: "info" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    if (res.status !== 0) {
        const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
        throw new Error(`prisma migrate deploy failed (status=${res.status}). ${out}`);
    }
}

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

describe("connectRoutes (GitHub callback)", () => {
    const envBackup = { ...process.env };
    const originalFetch = globalThis.fetch;
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-connect-gh-callback-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
        };
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        testEnvBase = { ...process.env };

        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
        await auth.init();
    }, 120_000);

    const restoreEnv = (base: NodeJS.ProcessEnv) => {
        for (const key of Object.keys(process.env)) {
            if (!(key in base)) delete (process.env as any)[key];
        }
        for (const [key, value] of Object.entries(base)) {
            if (typeof value === "string") process.env[key] = value;
        }
    };

    afterEach(async () => {
        await closeTrackedApps();
        restoreEnv(testEnvBase);
        vi.unstubAllGlobals();
        globalThis.fetch = originalFetch;
        await db.repeatKey.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await db.$disconnect();
        process.env = envBackup;
        globalThis.fetch = originalFetch;
        await rm(baseDir, { recursive: true, force: true });
    });

    it("redirects with invalid_profile when the provider /user response is missing required fields", async () => {
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

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
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED = "0";
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

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

        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED = "0";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE = "https://app.example.test/custom-oauth";

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
        process.env.GITHUB_CLIENT_ID = "client-id";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";

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
        delete process.env.GITHUB_CLIENT_ID;
        delete process.env.GITHUB_REDIRECT_URL;
        delete process.env.GITHUB_REDIRECT_URI;

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
        process.env.GITHUB_CLIENT_ID = "client-id";
        process.env.GITHUB_CLIENT_SECRET = "client-secret";
        process.env.HAPPIER_WEBAPP_URL = "https://webapp.example.test";

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-oauth-callback-u1" },
            select: { id: true },
        });

        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
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
