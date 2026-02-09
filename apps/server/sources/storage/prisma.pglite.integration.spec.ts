import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initDbPglite, shutdownDbPglite } from "./prisma";
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
        delete process.env.HAPPY_SERVER_LIGHT_DB_DIR;
        delete process.env.HAPPY_SERVER_LIGHT_DATA_DIR;
        delete process.env.HAPPIER_SERVER_LIGHT_DB_DIR;
        delete process.env.HAPPIER_SERVER_LIGHT_DATA_DIR;
        while (createdDirs.length > 0) {
            const dir = createdDirs.pop();
            if (!dir) continue;
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("rejects re-entrant init attempts while initialization is in progress", async () => {
        const root = await createHarnessDir();
        process.env.HAPPY_SERVER_LIGHT_DATA_DIR = root;

        const first = initDbPglite();
        const second = initDbPglite();
        const [firstResult, secondResult] = await Promise.allSettled([first, second]);

        expect(firstResult.status).toBe("fulfilled");
        expect(secondResult.status).toBe("rejected");
        expect(String((secondResult as PromiseRejectedResult).reason?.message ?? (secondResult as PromiseRejectedResult).reason)).toMatch(
            /initialization is already in progress/i,
        );
    }, 30_000);

    it("releases the pglite directory lock on shutdown", async () => {
        const root = await createHarnessDir();
        const dbDir = join(root, "pglite");
        process.env.HAPPY_SERVER_LIGHT_DATA_DIR = root;

        await initDbPglite();
        await shutdownDbPglite();

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test-after-shutdown" });
        await release();
    }, 30_000);

    it("does not keep partial initialization state when lock acquisition fails", async () => {
        const root = await createHarnessDir();
        const dbDir = join(root, "pglite");
        process.env.HAPPY_SERVER_LIGHT_DATA_DIR = root;

        const release = await acquirePgliteDirLock(dbDir, { purpose: "external-lock" });
        await expect(initDbPglite()).rejects.toThrow(/already in use/i);
        await release();

        await expect(initDbPglite()).resolves.toBeUndefined();
        await expect(shutdownDbPglite()).resolves.toBeUndefined();
    }, 30_000);

    it("accepts HAPPIER_ prefixed light data dir env var", async () => {
        const root = await createHarnessDir();
        const dbDir = join(root, "pglite");
        process.env.HAPPIER_SERVER_LIGHT_DATA_DIR = root;

        await expect(initDbPglite()).resolves.toBeUndefined();
        await shutdownDbPglite();

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test-happier-prefix-after-shutdown" });
        await release();
    }, 30_000);
});
