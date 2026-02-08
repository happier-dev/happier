import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { auth } from "@/app/auth/auth";
import { restoreEnv, snapshotEnv } from "@/app/api/testkit/env";
import { enableAuthentication } from "./enableAuthentication";
import { initEncrypt } from "@/modules/encrypt";
import { encryptString } from "@/modules/encrypt";

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

describe("enableAuthentication (auth policy) (integration)", () => {
    const envBackup = snapshotEnv();
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-decorator-"));
        const dbPath = join(baseDir, "test.sqlite");

        Object.assign(process.env, {
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
        });
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        testEnvBase = snapshotEnv();

        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
        await auth.init();
        await initEncrypt();
    }, 120_000);

    const createAuthenticatedApp = async () => {
        const app = Fastify({ logger: false }) as any;
        enableAuthentication(app);
        app.get("/private", { preHandler: app.authenticate }, async () => ({ ok: true }));
        await app.ready();
        return app;
    };

    const withAuthenticatedApp = async (run: (app: any) => Promise<void>) => {
        const app = await createAuthenticatedApp();
        try {
            await run(app);
        } finally {
            await app.close().catch(() => {});
        }
    };

    const withStubbedFetch = async (fetchImpl: typeof fetch, run: () => Promise<void>) => {
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", fetchImpl as any);
        try {
            await run();
        } finally {
            globalThis.fetch = originalFetch;
        }
    };

    afterEach(async () => {
        restoreEnv(testEnvBase);
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        await rm(baseDir, { recursive: true, force: true });
    });

    it("blocks authenticated requests when GitHub is required but the account is not linked", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        const token = await auth.createToken(account.id);

        await withAuthenticatedApp(async (app) => {
            const res = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${token}` },
            });

            expect(res.statusCode).toBe(403);
            expect(res.json()).toEqual({ error: "provider-required", provider: "github" });
        });
    });

    it("allows authenticated requests when GitHub is required and the account is linked", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });
        const token = await auth.createToken(account.id);

        await withAuthenticatedApp(async (app) => {
            const res = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${token}` },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ ok: true });
        });
    });

    it("blocks authenticated requests when GitHub allowlist does not include the linked user", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_USERS = "bob";

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });
        const token = await auth.createToken(account.id);

        await withAuthenticatedApp(async (app) => {
            const res = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${token}` },
            });

            expect(res.statusCode).toBe(403);
            expect(res.json()).toEqual({ error: "not-eligible" });
        });
    });

    it("allows authenticated requests when GitHub allowlist matches the linked user case-insensitively", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_USERS = "OctoCat";

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat" },
            },
        });
        const token = await auth.createToken(account.id);

        await withAuthenticatedApp(async (app) => {
            const res = await app.inject({
                method: "GET",
                url: "/private",
                headers: { authorization: `Bearer ${token}` },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ ok: true });
        });
    });

    it("blocks authenticated requests when GitHub org allowlist is configured and the user is not a member (github_app)", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_OFFBOARDING_ENABLED = "1";
        process.env.AUTH_OFFBOARDING_INTERVAL_SECONDS = "60";

        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        process.env.AUTH_GITHUB_APP_ID = "1";
        process.env.AUTH_GITHUB_APP_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
        process.env.AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG = "acme=123";

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
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
        const token = await auth.createToken(account.id);

        await withStubbedFetch(
            (async (url: any, init?: any) => {
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
            }) as any,
            async () => {
                await withAuthenticatedApp(async (app) => {
                    const res = await app.inject({
                        method: "GET",
                        url: "/private",
                        headers: { authorization: `Bearer ${token}` },
                    });

                    expect(res.statusCode).toBe(403);
                    expect(res.json()).toEqual({ error: "not-eligible" });
                });
            },
        );
    });

    it("allows authenticated requests when GitHub org allowlist is configured and the user is a member (oauth_user_token)", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";
        process.env.AUTH_OFFBOARDING_ENABLED = "1";
        process.env.AUTH_OFFBOARDING_INTERVAL_SECONDS = "60";
        process.env.GITHUB_STORE_ACCESS_TOKEN = "1";

        const account = await db.account.create({ data: { publicKey: "pk_1" } });
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
        const token = await auth.createToken(account.id);

        await withStubbedFetch(
            (async (url: any, init?: any) => {
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
            }) as any,
            async () => {
                await withAuthenticatedApp(async (app) => {
                    const res = await app.inject({
                        method: "GET",
                        url: "/private",
                        headers: { authorization: `Bearer ${token}` },
                    });

                    expect(res.statusCode).toBe(200);
                    expect(res.json()).toEqual({ ok: true });
                });
            },
        );
    });

    it("allows authenticated requests when GitHub org allowlist is configured and the user is a member (oauth_user_token via AccountIdentity.token)", async () => {
        process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "github";
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";
        process.env.AUTH_OFFBOARDING_ENABLED = "1";
        process.env.AUTH_OFFBOARDING_INTERVAL_SECONDS = "60";
        process.env.GITHUB_STORE_ACCESS_TOKEN = "1";

        const account = await db.account.create({ data: { publicKey: "pk_1_id_tok" } });
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
        const token = await auth.createToken(account.id);

        await withStubbedFetch(
            (async (url: any, init?: any) => {
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
            }) as any,
            async () => {
                await withAuthenticatedApp(async (app) => {
                    const res = await app.inject({
                        method: "GET",
                        url: "/private",
                        headers: { authorization: `Bearer ${token}` },
                    });

                    expect(res.statusCode).toBe(200);
                    expect(res.json()).toEqual({ ok: true });
                });
            },
        );
    });
});
