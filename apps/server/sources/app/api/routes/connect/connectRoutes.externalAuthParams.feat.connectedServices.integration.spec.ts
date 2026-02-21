import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { initDbSqlite, db } from "@/storage/db";

function restoreEnv(snapshot: Record<string, string | undefined>) {
    for (const k of Object.keys(process.env)) {
        if (!(k in snapshot)) {
            delete process.env[k];
        }
    }
    for (const [k, v] of Object.entries(snapshot)) {
        if (typeof v === "undefined") {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
}

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    return typed;
}

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

describe("connectRoutes (external auth params)", () => {
    let testEnvBase: Record<string, string | undefined> = {};
    const envBackup = { ...process.env };
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-auth-external-params-"));
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
        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
        await auth.init();
    });

    beforeEach(() => {
        testEnvBase = { ...process.env };
    });

    afterEach(async () => {
        await db.repeatKey.deleteMany().catch(() => {});
        restoreEnv(testEnvBase);
    });

    afterAll(async () => {
        await db.$disconnect();
        process.env = envBackup;
        await rm(baseDir, { recursive: true, force: true });
    });

    it("GET /v1/auth/external/github/params returns 200 with an OAuth URL when GitHub signup is enabled", async () => {
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";

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
        process.env.AUTH_SIGNUP_PROVIDERS = "github";
        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";
        process.env.AUTH_GITHUB_ALLOWED_ORGS = "acme";
        process.env.AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE = "oauth_user_token";

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
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS = "github";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "required_e2ee";

        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";

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
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS = "github";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE = "plain";

        process.env.GITHUB_CLIENT_ID = "gh_client";
        process.env.GITHUB_REDIRECT_URL = "https://api.example.test/v1/oauth/github/callback";

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
});
