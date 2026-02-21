import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { registerAccountEncryptionRoutes } from "./registerAccountEncryptionRoutes";

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

    return typed;
}

describe("registerAccountEncryptionRoutes (keyless accounts) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

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

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-account-encryption-keyless-"));
        const dbPath = join(baseDir, "test.sqlite");

        process.env = {
            ...process.env,
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            HAPPIER_SERVER_LIGHT_DATA_DIR: baseDir,
        };
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        testEnvBase = { ...process.env };

        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
    }, 120_000);

    afterEach(async () => {
        restoreEnv(testEnvBase);
        await db.accountIdentity.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        await rm(baseDir, { recursive: true, force: true });
    });

    it("rejects switching to e2ee when the account is keyless (publicKey is null)", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT = "1";

        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountEncryptionRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/account/encryption",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { mode: "e2ee" },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params" });

        const stored = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true },
        });
        expect(stored?.encryptionMode).toBe("plain");

        await app.close();
    });

    it("treats keyless accounts as plain on GET even if legacy rows store encryptionMode=e2ee", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "e2ee" },
            select: { id: true, encryptionModeUpdatedAt: true },
        });

        const app = createTestApp();
        registerAccountEncryptionRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v1/account/encryption",
            headers: { "x-test-user-id": account.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            mode: "plain",
            updatedAt: account.encryptionModeUpdatedAt.getTime(),
        });

        await app.close();
    });
});
