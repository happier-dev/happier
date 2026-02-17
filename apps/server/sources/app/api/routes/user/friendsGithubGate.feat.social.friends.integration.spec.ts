import Fastify from "fastify";
import { beforeAll, afterAll, describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { userRoutes } from "./userRoutes";
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
    const app = Fastify();
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

describe("Friends + GitHub gating (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-friends-github-"));
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
    }, 120_000);

    afterAll(async () => {
        await db.$disconnect();
        process.env = envBackup;
        await rm(baseDir, { recursive: true, force: true });
    });

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
        await db.repeatKey.deleteMany().catch(() => {});
        await db.accountIdentity.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("POST /v1/friends/add returns 404 not_found when friends feature is off", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "0";

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-friends-disabled-u1" },
            select: { id: true },
        });
        const u2 = await db.account.create({
            data: { publicKey: "pk-friends-disabled-u2" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/add",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": u1.id,
            },
            payload: { uid: u2.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        await app.close();
    });

    it("GET /v1/user/search returns 404 not_found when friends feature is off", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "0";

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-disabled-current" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=ali",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        await app.close();
    });

    it("GET /v1/friends returns 404 not_found when friends feature is off", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "0";

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-friends-list-disabled-current" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/friends",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        await app.close();
    });

    it("POST /v1/friends/remove returns 404 not_found when friends feature is off", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "0";

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-friends-remove-disabled-current", username: "remove_disabled_current" },
            select: { id: true },
        });
        const other = await db.account.create({
            data: { publicKey: "pk-friends-remove-disabled-other", username: "remove_disabled_other" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/remove",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": current.id,
            },
            payload: { uid: other.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        await app.close();
    });

    it("POST /v1/friends/add returns 400 provider-required when either user lacks the required identity provider", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "1";
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME = "0";
        process.env.GITHUB_CLIENT_ID = "test_client_id";
        process.env.GITHUB_CLIENT_SECRET = "test_client_secret";
        process.env.GITHUB_REDIRECT_URL = "https://app.example.test/oauth/github/callback";

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-friends-u1" },
            select: { id: true },
        });
        const u2 = await db.account.create({
            data: { publicKey: "pk-friends-u2" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/add",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": u1.id,
            },
            payload: { uid: u2.id },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "provider-required", provider: "github" });
        await app.close();
    });

    it("POST /v1/friends/add returns 400 username-required when username-based friends are enabled and either user lacks a username", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "1";
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME = "1";

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-friends-username-required-u1", username: "u_name_1" },
            select: { id: true },
        });
        const u2 = await db.account.create({
            data: { publicKey: "pk-friends-username-required-u2" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/add",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": u1.id,
            },
            payload: { uid: u2.id },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "username-required" });
        await app.close();
    });

    it("GET /v1/user/search returns only users connected to the required identity provider", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "1";
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME = "0";
        process.env.GITHUB_CLIENT_ID = "test_client_id";
        process.env.GITHUB_CLIENT_SECRET = "test_client_secret";
        process.env.GITHUB_REDIRECT_URL = "https://app.example.test/oauth/github/callback";

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-current" },
            select: { id: true },
        });

        const ghUser = await db.account.create({
            data: {
                publicKey: "pk-search-gh",
                username: "ghonly_alice",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: ghUser.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "ghonly_alice",
                profile: { login: "ghonly_alice" } as any,
            },
            select: { id: true },
        });

        await db.account.create({
            data: {
                publicKey: "pk-search-nogh",
                username: "ghonly_alicia",
            },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=ghonly_",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as { users: Array<{ id: string }> };
        expect(body.users.map((u) => u.id)).toEqual([ghUser.id]);
        await app.close();
    });

    it("GET /v1/user/search returns username accounts even without GitHub when username-based friends are enabled", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "1";
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME = "1";

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-usernames-current" },
            select: { id: true },
        });

        const usernameOnly = await db.account.create({
            data: {
                publicKey: "pk-search-usernames-nogh",
                username: "allowuser_alicia_username_only",
            },
            select: { id: true },
        });

        const ghUser = await db.account.create({
            data: {
                publicKey: "pk-search-usernames-gh",
                username: "allowuser_alice2",
            },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=allowuser_",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as { users: Array<{ id: string }> };
        expect(body.users.map((u) => u.id).sort()).toEqual([ghUser.id, usernameOnly.id].sort());
        await app.close();
    });

    it("GET /v1/user/search succeeds for light flavor when DB provider env is unset", async () => {
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED = "1";
        process.env.HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME = "1";
        process.env.HAPPIER_SERVER_FLAVOR = "light";
        process.env.HAPPY_SERVER_FLAVOR = "light";
        delete process.env.HAPPIER_DB_PROVIDER;
        delete process.env.HAPPY_DB_PROVIDER;

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-light-default-current", username: "light_default_current" },
            select: { id: true },
        });

        const match = await db.account.create({
            data: { publicKey: "pk-search-light-default-match", username: "lightdefault_alice" },
            select: { id: true },
        });

        await db.account.create({
            data: { publicKey: "pk-search-light-default-other", username: "otherprefix_bob" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=lightdefault_",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as { users: Array<{ id: string }> };
        expect(body.users.map((u) => u.id)).toContain(match.id);
        await app.close();
    });
});
