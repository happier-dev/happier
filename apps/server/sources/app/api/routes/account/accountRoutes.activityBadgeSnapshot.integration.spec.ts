import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { auth } from "@/app/auth/auth";
import { initEncrypt } from "@/modules/encrypt";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { accountRoutes } from "./accountRoutes";

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
    enableAuthentication(typed);
    accountRoutes(typed);
    return trackApp(typed);
}

describe("accountRoutes (activity badge snapshot) (integration)", () => {
    const envBackup = { ...process.env };
    let testEnvBase: NodeJS.ProcessEnv;
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-account-activity-badges-"));
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
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await db.$disconnect();
        restoreEnv(envBackup);
        await rm(baseDir, { recursive: true, force: true });
    });

    it("returns an unread-derived badgeCount when lastViewedSessionSeq is behind session.seq", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_activity_badges_1" } });
        const token = await auth.createToken(account.id);

        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "sess-1",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 3,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await db.$executeRawUnsafe(
            `UPDATE "Session" SET "lastViewedSessionSeq" = 1 WHERE "id" = '${session.id}'`,
        );

        const res = await app.inject({
            method: "GET",
            url: "/v1/account/activity/badge-snapshot",
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body).toMatchObject({
            badgeCount: 1,
        });
    });

    it("counts a session once when multiple activity reasons are active", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_activity_badges_2" } });
        const token = await auth.createToken(account.id);

        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "sess-2",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 5,
                pendingVersion: 0,
                pendingCount: 2,
                active: true,
            },
            select: { id: true },
        });

        await db.$executeRawUnsafe(
            `UPDATE "Session" SET "lastViewedSessionSeq" = 1, "pendingPermissionRequestCount" = 2, "pendingUserActionRequestCount" = 1 WHERE "id" = '${session.id}'`,
        );

        const res = await app.inject({
            method: "GET",
            url: "/v1/account/activity/badge-snapshot",
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body).toMatchObject({
            badgeCount: 1,
        });
    });

    it("returns badgeCount=0 when the account only has archived sessions", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_activity_badges_3" } });
        const token = await auth.createToken(account.id);

        await db.session.create({
            data: {
                accountId: account.id,
                tag: "sess-3",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 7,
                pendingVersion: 0,
                pendingCount: 3,
                lastViewedSessionSeq: 1,
                active: true,
                archivedAt: new Date("2026-03-18T00:00:00.000Z"),
            },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/account/activity/badge-snapshot",
            headers: { authorization: `Bearer ${token}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body).toMatchObject({
            badgeCount: 0,
        });
    });
});
