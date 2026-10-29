import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderPrismaCompatibleSqliteDatabaseUrl } from "@happier-dev/cli-common/firstPartyRuntime/server";

import { applyEnvValues } from "@/testkit/env";
import { createDbMaintenanceClient, db, getPrismaConnectionLimit, initDbPglite, prismaRuntime, shutdownDbPglite } from "./prisma";
import { acquirePgliteDirLock } from "./locks/pgliteLock";

const createdDirs: string[] = [];

async function createHarnessDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "happier-prisma-pglite-"));
    createdDirs.push(dir);
    return dir;
}

async function safeShutdownPglite(): Promise<void> {
    await shutdownDbPglite().catch(() => {});
}

describe("storage/prisma initDbPglite", () => {
    afterEach(async () => {
        await safeShutdownPglite();
        applyEnvValues({
            HAPPY_SERVER_LIGHT_DB_DIR: undefined,
            HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
            HAPPIER_SERVER_LIGHT_DB_DIR: undefined,
            HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
        });
        while (createdDirs.length > 0) {
            const dir = createdDirs.pop();
            if (!dir) continue;
            await rm(dir, { recursive: true, force: true });
        }
        vi.unstubAllEnvs();
    });

    it("rejects re-entrant init attempts while initialization is in progress", async () => {
        vi.stubEnv("HAPPIER_DB_CONNECTION_LIMIT", "7");
        vi.stubEnv("TOKIO_WORKER_THREADS", undefined);
        const root = await createHarnessDir();
        applyEnvValues({ HAPPY_SERVER_LIGHT_DATA_DIR: root });

        const first = initDbPglite();
        const second = initDbPglite();
        const [firstResult, secondResult] = await Promise.allSettled([first, second]);

        expect(firstResult.status).toBe("fulfilled");
        expect.soft(getPrismaConnectionLimit()).toBe(1);
        expect.soft(process.env.TOKIO_WORKER_THREADS).toBe("1");
        expect(secondResult.status).toBe("rejected");
        expect(String((secondResult as PromiseRejectedResult).reason?.message ?? (secondResult as PromiseRejectedResult).reason)).toMatch(
            /initialization is already in progress/i,
        );
    }, 30_000);

    it("releases the pglite directory lock on shutdown", async () => {
        const root = await createHarnessDir();
        const dbDir = join(root, "pglite");
        applyEnvValues({ HAPPY_SERVER_LIGHT_DATA_DIR: root });

        await initDbPglite();
        expect(await db.$queryRaw(prismaRuntime.sql`SELECT ${17}::int AS value`)).toEqual([{ value: 17 }]);
        await shutdownDbPglite();

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test-after-shutdown" });
        await release();
    }, 30_000);

    it("executes queries without allocating request call-site Errors", async () => {
        const root = await createHarnessDir();
        applyEnvValues({ HAPPY_SERVER_LIGHT_DATA_DIR: root });
        // Development is the capture-enabled Prisma default; production alone
        // would conceal a regression in the storage owner's explicit policy.
        vi.stubEnv("NODE_ENV", "development");
        await initDbPglite();
        await db.$queryRaw`SELECT 1`;
        const sqlite = await createDbMaintenanceClient("sqlite", renderPrismaCompatibleSqliteDatabaseUrl({
            dbPath: join(root, "count.sqlite"), platform: process.platform,
        }));
        await sqlite.$queryRaw`SELECT 1`;

        const NativeError = globalThis.Error;
        let captures = 0;
        const providerCaptures: number[] = [];
        const CountingError = new Proxy(NativeError, {
            construct(target, args, newTarget) {
                // Prisma 6.19's EnabledCallSite creates a native Error with no
                // arguments when the lazy query promise is evaluated.
                if (args.length === 0) captures += 1;
                return Reflect.construct(target, args, newTarget);
            },
        });
        const queryCount = 32;
        try {
            for (const client of [db, sqlite]) {
                captures = 0;
                globalThis.Error = CountingError;
                for (let index = 0; index < queryCount; index += 1) {
                    const rows = await client.$queryRaw<Array<{ value: number | bigint }>>`SELECT 1 AS value`;
                    expect(Number(rows[0].value)).toBe(1);
                }
                globalThis.Error = NativeError;
                providerCaptures.push(captures);
            }
        } finally {
            globalThis.Error = NativeError;
            await sqlite.$disconnect();
        }
        expect(providerCaptures).toEqual([0, 0]);
    }, 30_000);

    it("does not keep partial initialization state when lock acquisition fails", async () => {
        const root = await createHarnessDir();
        const dbDir = join(root, "pglite");
        applyEnvValues({ HAPPY_SERVER_LIGHT_DATA_DIR: root });

        const release = await acquirePgliteDirLock(dbDir, { purpose: "external-lock" });
        await expect(initDbPglite()).rejects.toThrow(/already in use/i);
        await release();

        await expect(initDbPglite()).resolves.toBeUndefined();
        await expect(shutdownDbPglite()).resolves.toBeUndefined();
    }, 30_000);

    it("accepts HAPPIER_ prefixed light data dir env var", async () => {
        const root = await createHarnessDir();
        const dbDir = join(root, "pglite");
        applyEnvValues({ HAPPIER_SERVER_LIGHT_DATA_DIR: root });

        await expect(initDbPglite()).resolves.toBeUndefined();
        await shutdownDbPglite();

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test-happier-prefix-after-shutdown" });
        await release();
    }, 30_000);
});
