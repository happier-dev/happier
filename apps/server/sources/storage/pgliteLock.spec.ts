import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquirePgliteDirLock, getPgliteDirLockPath, PGLITE_LOCK_FILENAME } from "./pgliteLock";

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "happier-pglite-lock-"));
    return dir;
}

describe("storage/pgliteLock", () => {
    const createdPaths: string[] = [];

    afterEach(async () => {
        while (createdPaths.length) {
            const path = createdPaths.pop();
            if (!path) continue;
            await rm(path, { recursive: true, force: true });
        }
    });

    it("creates and releases the lock file", async () => {
        const dbDir = await makeTempDir();
        createdPaths.push(dbDir);
        await mkdir(dbDir, { recursive: true });

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test" });
        const lockPath = getPgliteDirLockPath(dbDir);
        const raw = await readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw);

        expect(parsed.pid).toBe(process.pid);
        expect(parsed.purpose).toBe("test");
        expect(parsed.dbDir).toBe(dbDir);
        expect(typeof parsed.createdAt).toBe("string");

        await release();
        await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not remove a lock file owned by a different pid when releasing", async () => {
        const dbDir = await makeTempDir();
        createdPaths.push(dbDir);
        await mkdir(dbDir, { recursive: true });

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test" });
        const lockPath = getPgliteDirLockPath(dbDir);

        // Simulate another process acquiring the lock between acquire() and release().
        const otherPid = process.pid + 1;
        await writeFile(
            lockPath,
            JSON.stringify({ pid: otherPid, createdAt: new Date().toISOString(), purpose: "someone-else", dbDir }) + "\n",
            "utf8",
        );

        await release();

        const raw = await readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw);
        expect(parsed.pid).toBe(otherPid);

        await rm(lockPath, { force: true });
    });

    it("fails when the lock is held by a live pid", async () => {
        const dbDir = await makeTempDir();
        createdPaths.push(dbDir);
        await mkdir(dbDir, { recursive: true });

        const lockPath = getPgliteDirLockPath(dbDir);
        await writeFile(
            lockPath,
            JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), purpose: "someone-else", dbDir }) + "\n",
            "utf8",
        );

        await expect(acquirePgliteDirLock(dbDir, { purpose: "test" })).rejects.toThrow(/already in use/i);
    });

    it("removes a stale lock file and acquires a new lock", async () => {
        const dbDir = await makeTempDir();
        createdPaths.push(dbDir);
        await mkdir(dbDir, { recursive: true });

        const lockPath = getPgliteDirLockPath(dbDir);
        await writeFile(
            lockPath,
            JSON.stringify({ pid: 999999, createdAt: new Date().toISOString(), purpose: "stale", dbDir }) + "\n",
            "utf8",
        );

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test" });
        const raw = await readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw);
        expect(parsed.pid).toBe(process.pid);
        expect(parsed.purpose).toBe("test");
        await release();
    });

    it("treats an invalid lock file as stale and replaces it", async () => {
        const dbDir = await makeTempDir();
        createdPaths.push(dbDir);
        await mkdir(dbDir, { recursive: true });

        const lockPath = getPgliteDirLockPath(dbDir);
        await writeFile(lockPath, "not-json\n", "utf8");

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test" });
        const raw = await readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw);
        expect(parsed.pid).toBe(process.pid);
        await release();
    });

    it("does not clobber a legacy lock file that points to a different dbDir", async () => {
        const parentDir = await makeTempDir();
        createdPaths.push(parentDir);
        const dbDir = join(parentDir, "db");
        await mkdir(dbDir, { recursive: true });

        const lockPath = getPgliteDirLockPath(dbDir);
        const legacyAdjacentLockPath = join(parentDir, PGLITE_LOCK_FILENAME);
        await writeFile(
            legacyAdjacentLockPath,
            JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), purpose: "other", dbDir: "/tmp/other" }) + "\n",
            "utf8",
        );

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test" });
        const raw = await readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw);
        expect(parsed.dbDir).toBe(dbDir);
        await release();

        const legacyRaw = await readFile(legacyAdjacentLockPath, "utf8");
        const legacyParsed = JSON.parse(legacyRaw);
        expect(legacyParsed.dbDir).toBe("/tmp/other");
    });

    it("does not delete an unreadable legacy adjacent lock file", async () => {
        const parentDir = await makeTempDir();
        createdPaths.push(parentDir);
        const dbDir = join(parentDir, "db");
        await mkdir(dbDir, { recursive: true });

        const legacyAdjacentLockPath = join(parentDir, PGLITE_LOCK_FILENAME);
        await writeFile(legacyAdjacentLockPath, "not-json\n", "utf8");

        await expect(acquirePgliteDirLock(dbDir, { purpose: "test" })).rejects.toThrow(/legacy lock/i);

        const legacyRaw = await readFile(legacyAdjacentLockPath, "utf8");
        expect(legacyRaw).toBe("not-json\n");
    });

    it("removes legacy lock files that live inside dbDir", async () => {
        const dbDir = await makeTempDir();
        createdPaths.push(dbDir);
        await mkdir(dbDir, { recursive: true });

        // Legacy location: <dbDir>/.happier.pglite.lock
        const legacyLockPath = join(dbDir, PGLITE_LOCK_FILENAME);
        await writeFile(legacyLockPath, "legacy\n", "utf8");

        const release = await acquirePgliteDirLock(dbDir, { purpose: "test" });
        await expect(readFile(legacyLockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await release();
    });
});
