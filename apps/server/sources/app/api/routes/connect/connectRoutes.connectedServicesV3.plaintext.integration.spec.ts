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

describe("connectRoutes (connected services v3) plaintext credential endpoints (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-connected-services-v3-"));
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
        await initEncrypt();
        await auth.init();
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
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("stores and returns a plaintext credential envelope for plaintext accounts (server sealed at rest)", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE = "plain";
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST = "server_sealed";

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const record = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            kind: "oauth",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: {
                accessToken: "tok_access",
                refreshToken: "tok_refresh",
                idToken: null,
                scope: null,
                tokenType: null,
                providerAccountId: null,
                providerEmail: "user@example.com",
                raw: null,
            },
            token: null,
        };

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: record } },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({ content: { t: "plain", v: expect.any(Object) } });

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { token: true },
        });
        expect(row).not.toBeNull();
        const tokenUtf8 = Buffer.from(row!.token).toString("utf8");
        expect(tokenUtf8.includes("tok_access")).toBe(false);
    });

    it("rejects plaintext credential content for e2ee accounts", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "required_e2ee";

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: {} } },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params" });
    });

    it("does not return v3 plaintext credentials for e2ee accounts (defense-in-depth)", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "required_e2ee";

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const now = Date.now();
        const record = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            kind: "oauth",
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: {
                accessToken: "tok_access",
                refreshToken: "tok_refresh",
                idToken: null,
                scope: null,
                tokenType: null,
                providerAccountId: null,
                providerEmail: "user@example.com",
                raw: null,
            },
            token: null,
        };

        await db.serviceAccountToken.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                token: Buffer.from(JSON.stringify(record), "utf8"),
                metadata: {
                    v: 3,
                    storage: "plain_json_v1",
                    kind: "oauth",
                    providerEmail: "user@example.com",
                    providerAccountId: null,
                },
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/credential",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);
        expect(getOne.json()).toEqual({ error: "connect_credential_not_found" });
    });
});
