import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { userRoutes } from "./userRoutes";
import { auth } from "@/app/auth/auth";

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

    return typed;
}

describe("userRoutes (profile badges) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-user-badges-"));
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
    }, 120_000);

	    afterAll(async () => {
	        await db.$disconnect();
	        restoreEnv(envBackup);
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

    afterEach(() => {
        restoreEnv(testEnvBase);
        vi.unstubAllGlobals();
    });

    it("includes GitHub badge when an identity is linked and showOnProfile=true", async () => {
        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const viewer = await db.account.create({ data: { publicKey: "pk-viewer", username: "viewer" }, select: { id: true } });
        const target = await db.account.create({ data: { publicKey: "pk-target", username: "target" }, select: { id: true } });

        await db.accountIdentity.create({
            data: {
                accountId: target.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "x" } as any,
                showOnProfile: true,
            },
        });

        const res = await app.inject({
            method: "GET",
            url: `/v1/user/${encodeURIComponent(target.id)}`,
            headers: { "x-test-user-id": viewer.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body.user?.badges).toEqual([
            {
                id: "github",
                label: "@octocat",
                url: "https://github.com/octocat",
            },
        ]);

        await app.close();
    });
});
