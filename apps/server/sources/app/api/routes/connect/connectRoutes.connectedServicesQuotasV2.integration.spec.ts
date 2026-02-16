import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

describe("connectRoutes (connected services quotas v2) sealed quota snapshot endpoints (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-connected-services-quotas-v2-"));
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
        await (db as any).serviceAccountQuotaSnapshot?.deleteMany?.().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("does not register quota snapshot routes when HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED=0", async () => {
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = "0";
        const user = await db.account.create({ data: { publicKey: "pk-quota-disabled" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(res.statusCode).toBe(404);
    });

    it("stores and returns sealed quota snapshots when enabled", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-quota-enabled" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const put = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt: Date.now(), staleAfterMs: 300000, status: "ok" },
            }),
        });
        expect(put.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(get.statusCode).toBe(200);
        const body = get.json() as any;
        expect(body.sealed?.format).toBe("account_scoped_v1");
        expect(body.sealed?.ciphertext).toBe("ciphertext-quota-snapshot");
        expect(typeof body.metadata?.fetchedAt).toBe("number");
        expect(typeof body.metadata?.staleAfterMs).toBe("number");
        expect(body.metadata?.status).toBe("ok");
    });

    it("accepts a refresh request and exposes refreshRequestedAt in metadata", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt, staleAfterMs: 300000, status: "ok" },
            }),
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({}),
        });
        expect(refresh.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        const body = get.json() as any;
        expect(typeof body.metadata?.refreshRequestedAt).toBe("number");
        expect(body.metadata.refreshRequestedAt).toBeGreaterThan(0);
    });

    it("includes refreshRequestedAt in metadata even when it is 0", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh-zero" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt, staleAfterMs: 300000, status: "ok" },
            }),
        });

        const existing = await (db as any).serviceAccountQuotaSnapshot?.findUnique?.({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { id: true, metadata: true },
        });
        expect(existing?.id).toBeTruthy();

        await (db as any).serviceAccountQuotaSnapshot?.update?.({
            where: { id: existing.id },
            data: { metadata: { ...(existing.metadata ?? {}), refreshRequestedAt: 0 } },
        });

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(get.statusCode).toBe(200);
        const body = get.json() as any;
        expect(body.metadata).toHaveProperty("refreshRequestedAt");
        expect(body.metadata.refreshRequestedAt).toBe(0);
    });

    it("rejects oversized ciphertext payloads", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-quota-oversize" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const huge = "x".repeat(400_000);
        const put = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: huge },
                metadata: { fetchedAt: Date.now(), staleAfterMs: 300000, status: "ok" },
            }),
        });
        expect(put.statusCode).toBe(400);
    });
});
