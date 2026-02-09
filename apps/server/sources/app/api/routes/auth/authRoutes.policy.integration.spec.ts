import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { auth } from "@/app/auth/auth";
import { authRoutes } from "./authRoutes";
import { initEncrypt } from "@/modules/encrypt";
import { encryptString } from "@/modules/encrypt";
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
    return trackApp(typed);
}

function createAuthBody() {
    const seed = new Uint8Array(32).fill(7);
    const kp = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = new Uint8Array(32).fill(9);
    const signature = tweetnacl.sign.detached(challenge, kp.secretKey);
    return {
        secretSeed: seed,
        publicKeyHex: privacyKit.encodeHex(new Uint8Array(kp.publicKey)),
        body: {
            publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
            challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
            signature: privacyKit.encodeBase64(new Uint8Array(signature)),
        },
    };
}

describe("authRoutes (auth policy) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-policy-"));
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
        await closeTrackedApps();
        restoreEnv(testEnvBase);
        vi.unstubAllGlobals();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await db.$disconnect();
        process.env = envBackup;
        await rm(baseDir, { recursive: true, force: true });
    });

    it("returns 403 signup-disabled when anonymous signup is disabled and the account does not exist", async () => {
        process.env.AUTH_ANONYMOUS_SIGNUP_ENABLED = "0";

        const { body } = createAuthBody();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "signup-disabled" });

        await app.close();
    });

    it("returns 403 provider-required when a required identity provider is missing", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";

        const { body, publicKeyHex } = createAuthBody();
        await db.account.create({ data: { publicKey: publicKeyHex } });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "provider-required", provider: "github" });

        await app.close();
    });

    it("issues a token when GitHub is required for login and the account has a linked github identity", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json.success).toBe(true);
        expect(typeof json.token).toBe("string");
        expect(json.token.length).toBeGreaterThan(10);

        await app.close();
    });

    it("returns 403 not-eligible when GitHub is required and the GitHub allowlist does not include the user", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_USERS = "bob";

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("returns 403 not-eligible (not 500) when GitHub allowlist is configured but providerLogin is null", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_USERS = "bob";

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: null,
                profile: { id: 123, login: "octocat" },
            },
        });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("returns 403 not-eligible when GitHub org allowlist is configured and the user is not a member (github_app)", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_OFFBOARDING_ENABLED = "1";
        process.env.AUTH_OFFBOARDING_INTERVAL_SECONDS = "60";

        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        process.env.AUTH_GITHUB_APP_ID = "1";
        process.env.AUTH_GITHUB_APP_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
        process.env.AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG = "acme=123";

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                eligibilityNextCheckAt: new Date(0),
            },
        });

        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (async (url: any, init?: any) => {
            const href = typeof url === "string" ? url : url?.href?.toString?.() ?? String(url);
            if (href.includes("/app/installations/123/access_tokens")) {
                return new Response(JSON.stringify({ token: "inst_tok", expires_at: new Date(Date.now() + 60_000).toISOString() }), {
                    status: 201,
                    headers: { "content-type": "application/json" },
                });
            }
            if (href.includes("/orgs/acme/members/octocat")) {
                return new Response(JSON.stringify({ message: "Not Found" }), {
                    status: 404,
                    headers: { "content-type": "application/json" },
                });
            }
            throw new Error(`Unexpected fetch: ${href} ${JSON.stringify(init ?? {})}`);
        }) as any);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        globalThis.fetch = originalFetch;

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "not-eligible" });

        await app.close();
    });

    it("returns 200 when GitHub org allowlist is configured and the user is a member (oauth_user_token)", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";
        process.env.GITHUB_STORE_ACCESS_TOKEN = "1";

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
                token: encryptString(["user", account.id, "github", "token"], "user_tok") as any,
                eligibilityNextCheckAt: new Date(0),
            },
        });

        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (async (url: any, init?: any) => {
            const href = typeof url === "string" ? url : url?.href?.toString?.() ?? String(url);
            if (href.includes("/orgs/acme/members/octocat")) {
                const authHeader = (init as any)?.headers?.Authorization ?? (init as any)?.headers?.authorization ?? "";
                if (!String(authHeader).includes("Bearer user_tok")) {
                    return new Response(JSON.stringify({ message: "Unauthorized" }), {
                        status: 401,
                        headers: { "content-type": "application/json" },
                    });
                }
                return new Response(null, { status: 204 });
            }
            throw new Error(`Unexpected fetch: ${href} ${JSON.stringify(init ?? {})}`);
        }) as any);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        globalThis.fetch = originalFetch;

        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(json.success).toBe(true);
        expect(typeof json.token).toBe("string");

        await app.close();
    });

    it("returns 200 when GitHub org allowlist is configured and the user is a member (oauth_user_token via AccountIdentity.token)", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";
        process.env.GITHUB_STORE_ACCESS_TOKEN = "1";

        const { body, publicKeyHex } = createAuthBody();
        const account = await db.account.create({ data: { publicKey: publicKeyHex } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat", avatar_url: "x", name: null } as any,
                token: encryptString(["user", account.id, "github", "token"], "user_tok") as any,
                eligibilityNextCheckAt: new Date(0),
            },
        });

        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (async (url: any, init?: any) => {
            const href = typeof url === "string" ? url : url?.href?.toString?.() ?? String(url);
            if (href.includes("/orgs/acme/members/octocat")) {
                const authHeader = (init as any)?.headers?.Authorization ?? (init as any)?.headers?.authorization ?? "";
                if (!String(authHeader).includes("Bearer user_tok")) {
                    return new Response(JSON.stringify({ message: "Unauthorized" }), {
                        status: 401,
                        headers: { "content-type": "application/json" },
                    });
                }
                return new Response(null, { status: 204 });
            }
            throw new Error(`Unexpected fetch: ${href} ${JSON.stringify(init ?? {})}`);
        }) as any);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: body,
        });

        globalThis.fetch = originalFetch;

        expect(res.statusCode).toBe(200);
        const json = res.json() as any;
        expect(json.success).toBe(true);
        expect(typeof json.token).toBe("string");

        await app.close();
    });
});
