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
import { initEncrypt } from "@/modules/encrypt";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

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
    return typed;
}

describe("connectRoutes (GitHub callback) external auth flow (integration)", () => {
    const envBackup = { ...process.env };
    const originalFetch = globalThis.fetch;
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-external-callback-"));
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
        await initEncrypt();
    }, 120_000);

    const restoreEnv = (base: NodeJS.ProcessEnv) => {
        for (const key of Object.keys(process.env)) {
            if (!(key in base)) {
                delete (process.env as any)[key];
            }
        }
        for (const [key, value] of Object.entries(base)) {
            if (typeof value === "string") {
                process.env[key] = value;
            }
        }
    };

    afterEach(async () => {
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

    it("creates a pending auth record and redirects without creating an account", async () => {
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";
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

    it("redirects with an oauth error when the user denies access (no code)", async () => {
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";
        process.env.HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE = "http://evil.example.test/oauth";
        process.env.HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES = "http";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";
        delete process.env.OAUTH_PENDING_TTL_SECONDS;
        process.env.GITHUB_OAUTH_PENDING_TTL_SECONDS = "120";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";
        process.env.HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE = "javascript:alert(1)";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";
        process.env.HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE = "myapp://oauth";
        process.env.HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES = "myapp";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

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
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_CLIENT_SECRET = "gh_secret";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.HAPPIER_WEBAPP_URL = "https://app.example.test";

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
