import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { ConnectedServiceQuotaSnapshotV1Schema } from "@happier-dev/protocol";

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

describe("connectRoutes (connected services quotas v3) plaintext quota endpoints (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-connected-services-quotas-v3-"));
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
        await db.serviceAccountQuotaSnapshot.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("stores and returns a plaintext quota envelope for plaintext accounts (server sealed at rest)", async () => {
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = "true";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE = "plain";
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST = "server_sealed";

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: "plan-secret-12345",
            accountLabel: null,
            meters: [
                {
                    meterId: "weekly",
                    label: "Weekly",
                    used: 82,
                    limit: 100,
                    unit: "count",
                    utilizationPct: null,
                    resetsAt: null,
                    status: "ok",
                    details: {},
                },
            ],
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            content: { t: "plain", v: expect.any(Object) },
            metadata: {
                fetchedAt: snapshot.fetchedAt,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });

        const row = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { snapshot: true },
        });
        expect(row).not.toBeNull();
        const snapshotUtf8 = Buffer.from(row!.snapshot).toString("utf8");
        expect(snapshotUtf8.includes("plan-secret-12345")).toBe(false);
    });

    it("adds refreshRequestedAt in metadata when requesting a refresh", async () => {
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = "true";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE = "plain";

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(register.statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);
        expect(refresh.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        const body = getOne.json() as any;
        expect(body.metadata.refreshRequestedAt).toEqual(expect.any(Number));
        expect(body.metadata.refreshRequestedAt).toBeGreaterThanOrEqual(snapshot.fetchedAt);
    });

    it("rejects plaintext quota content for e2ee accounts", async () => {
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = "true";
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
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: {} }, metadata: { fetchedAt: 1, staleAfterMs: 60_000, status: "ok" } },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params" });
    });

    it("does not return v3 plaintext quota snapshots for e2ee accounts (defense-in-depth)", async () => {
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = "true";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "required_e2ee";

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        };

        await db.serviceAccountQuotaSnapshot.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                snapshot: Buffer.from(JSON.stringify(snapshot), "utf8"),
                status: "ok",
                fetchedAt: new Date(now),
                staleAfterMs: 60_000,
                metadata: { v: 3, storage: "plain_json_v1" },
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);
        expect(getOne.json()).toEqual({ error: "connect_quotas_not_found" });
    });
});
