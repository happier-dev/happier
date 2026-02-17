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

describe("connectRoutes (vendor tokens) presence-only reads (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-vendor-tokens-"));
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

    it("returns 404 not_found when connected services are disabled (and does so before auth)", async () => {
        process.env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED = "0";

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v1/connect/tokens",
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
    });

    it("does not return decrypted tokens from GET endpoints", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-vendor-tokens-u1" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v1/connect/openai/register",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { token: "sk-test" },
        });
        if (register.statusCode !== 200) {
            throw new Error(`register failed: ${register.statusCode} ${register.body}`);
        }
        expect(register.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v1/connect/openai/token",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({ hasToken: true });

        const getAll = await app.inject({
            method: "GET",
            url: "/v1/connect/tokens",
            headers: { "x-test-user-id": user.id },
        });
        expect(getAll.statusCode).toBe(200);
        expect(getAll.json()).toEqual({
            tokens: [{ vendor: "openai", hasToken: true }],
        });
    });

    it("rejects v1 vendor token registration when a v2 connected service credential already exists", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-vendor-tokens-u2" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const registerV2 = await app.inject({
            method: "POST",
            url: "/v2/connect/anthropic/profiles/default/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });
        expect(registerV2.statusCode).toBe(200);

        const legacyRegister = await app.inject({
            method: "POST",
            url: "/v1/connect/anthropic/register",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { token: "legacy-token" },
        });
        expect(legacyRegister.statusCode).toBe(409);
        expect(legacyRegister.json()).toEqual({ error: "connect_credential_conflict" });

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "anthropic", profileId: "default" } },
            select: { token: true, metadata: true },
        });
        expect(row).not.toBeNull();
        expect(Buffer.from(row!.token).toString("utf8")).toBe("c2VhbGVk");
        expect((row!.metadata as any)?.v).toBe(2);
    });

    it("rejects v1 vendor token deletion when a v2 connected service credential already exists", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-vendor-tokens-u3" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const registerV2 = await app.inject({
            method: "POST",
            url: "/v2/connect/anthropic/profiles/default/credential",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "c2VhbGVk" },
                metadata: { kind: "oauth", providerEmail: "user@example.com", expiresAt: Date.now() + 3600_000 },
            },
        });
        expect(registerV2.statusCode).toBe(200);

        const legacyDelete = await app.inject({
            method: "DELETE",
            url: "/v1/connect/anthropic",
            headers: { "x-test-user-id": user.id },
        });
        expect(legacyDelete.statusCode).toBe(409);
        expect(legacyDelete.json()).toEqual({ error: "connect_credential_conflict" });

        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "anthropic", profileId: "default" } },
            select: { token: true, metadata: true },
        });
        expect(row).not.toBeNull();
        expect(Buffer.from(row!.token).toString("utf8")).toBe("c2VhbGVk");
        expect((row!.metadata as any)?.v).toBe(2);
    });
});
