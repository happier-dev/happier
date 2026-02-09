import { open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const PGLITE_LOCK_FILENAME = ".happier.pglite.lock";

type PgliteLockInfo = {
    pid: number;
    createdAt: string;
    purpose?: string;
    dbDir?: string;
};

function isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        if (err?.code === "ESRCH") return false;
        // EPERM and other errors mean "we can't signal it" but it likely exists.
        return true;
    }
}

function parseEtimeToMs(raw: string): number | null {
    // ps etime formats:
    //   MM:SS
    //   HH:MM:SS
    //   DD-HH:MM:SS
    const s = String(raw ?? "").trim();
    if (!s) return null;
    const [dayPart, timePart] = s.includes("-") ? s.split("-", 2) : [null, s];
    const day = dayPart ? Number(dayPart) : 0;
    if (!Number.isFinite(day) || day < 0) return null;
    const parts = timePart.split(":").map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 2) {
        const [m, sec] = parts;
        return ((day * 24 * 60 + m) * 60 + sec) * 1000;
    }
    if (parts.length === 3) {
        const [h, m, sec] = parts;
        return (((day * 24 + h) * 60 + m) * 60 + sec) * 1000;
    }
    return null;
}

function getProcessStartTimeMs(pid: number, nowMs = Date.now()): number | null {
    try {
        const res = spawnSync("ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8" });
        if (res.status !== 0) return null;
        const etime = parseEtimeToMs(res.stdout);
        if (etime == null) return null;
        return nowMs - etime;
    } catch {
        return null;
    }
}

async function readLockInfo(lockPath: string): Promise<PgliteLockInfo | null> {
    try {
        const raw = await readFile(lockPath, "utf8");
        const parsed = raw.trim() ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object") return null;
        const pid = Number((parsed as any).pid);
        const createdAt = String((parsed as any).createdAt ?? "");
        const purpose = typeof (parsed as any).purpose === "string" ? (parsed as any).purpose : undefined;
        const dbDir = typeof (parsed as any).dbDir === "string" ? (parsed as any).dbDir : undefined;
        if (!Number.isFinite(pid) || pid <= 0) return null;
        if (!createdAt.trim()) return null;
        return { pid, createdAt, purpose, dbDir };
    } catch {
        return null;
    }
}

type LockInfoDisposition =
    | { kind: "missing" }
    | { kind: "invalid" }
    | { kind: "valid"; info: PgliteLockInfo };

async function readLockInfoDisposition(lockPath: string): Promise<LockInfoDisposition> {
    let raw: string;
    try {
        raw = await readFile(lockPath, "utf8");
    } catch (err: any) {
        if (err?.code === "ENOENT") return { kind: "missing" };
        return { kind: "invalid" };
    }

    try {
        const parsed = raw.trim() ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object") return { kind: "invalid" };
        const pid = Number((parsed as any).pid);
        const createdAt = String((parsed as any).createdAt ?? "");
        const purpose = typeof (parsed as any).purpose === "string" ? (parsed as any).purpose : undefined;
        const dbDir = typeof (parsed as any).dbDir === "string" ? (parsed as any).dbDir : undefined;
        if (!Number.isFinite(pid) || pid <= 0) return { kind: "invalid" };
        if (!createdAt.trim()) return { kind: "invalid" };
        return { kind: "valid", info: { pid, createdAt, purpose, dbDir } };
    } catch {
        return { kind: "invalid" };
    }
}

async function removeLockFileBestEffort(lockPath: string): Promise<void> {
    try {
        await unlink(lockPath);
    } catch (err: any) {
        if (err?.code === "ENOENT") return;
        throw err;
    }
}

export function getPgliteDirLockPath(dbDir: string): string {
    // Keep the lock adjacent (not inside) the pglite DB dir, but make it unique per dbDir.
    const short = createHash("sha256").update(dbDir).digest("hex").slice(0, 12);
    return join(dirname(dbDir), `${PGLITE_LOCK_FILENAME}.${short}`);
}

export async function acquirePgliteDirLock(
    dbDir: string,
    { purpose }: { purpose: string },
): Promise<() => Promise<void>> {
    // IMPORTANT:
    // Do not write arbitrary files inside the pglite DB directory. Some pglite/wasm builds are
    // sensitive to unexpected extra files and can hard-abort. Keep the lock adjacent.
    const lockPath = getPgliteDirLockPath(dbDir);

    // If a legacy adjacent lock exists (older versions used a shared filename), treat it as authoritative
    // to avoid running concurrently with older servers.
    const legacyAdjacentLockPath = join(dirname(dbDir), PGLITE_LOCK_FILENAME);
    if (legacyAdjacentLockPath !== lockPath) {
        const firstRead = await readLockInfoDisposition(legacyAdjacentLockPath);
        const legacy =
            firstRead.kind === "invalid" ? await readLockInfoDisposition(legacyAdjacentLockPath) : firstRead;

        if (legacy.kind === "valid") {
            const legacyInfo = legacy.info;
            const sameDbDir = legacyInfo.dbDir ? legacyInfo.dbDir === dbDir : true;
            const legacyAlive = legacyInfo.pid ? isPidAlive(legacyInfo.pid) : false;
            if (sameDbDir) {
                if (legacyAlive) {
                    const details =
                        `pid=${legacyInfo.pid}` +
                        `${legacyInfo.purpose ? ` purpose=${legacyInfo.purpose}` : ""}` +
                        `${legacyInfo.createdAt ? ` createdAt=${legacyInfo.createdAt}` : ""}`;
                    throw new Error(
                        `[pglite] DB directory is already in use (${details}). ` +
                            `Stop the running server that uses this DB dir, then retry. ` +
                            `If you're sure nothing is running, delete the lock file: ${legacyAdjacentLockPath}`,
                    );
                }
                await removeLockFileBestEffort(legacyAdjacentLockPath).catch(() => {});
            }
            // Different dbDir: leave the legacy lock file untouched (it may belong to another DB dir).
        } else if (legacy.kind === "invalid") {
            throw new Error(`[pglite] Invalid legacy lock file: ${legacyAdjacentLockPath}`);
        }
    }
    // Cleanup legacy location from earlier versions (best-effort).
    // Leaving this file inside the DB dir has caused pglite hard-aborts in some environments.
    const legacyLockPath = join(dbDir, PGLITE_LOCK_FILENAME);
    if (legacyLockPath !== lockPath) {
        await removeLockFileBestEffort(legacyLockPath).catch(() => {});
    }

    const create = async () => {
        const handle = await open(lockPath, "wx", 0o600);
        try {
            const payload: PgliteLockInfo = {
                pid: process.pid,
                createdAt: new Date().toISOString(),
                purpose,
                dbDir,
            };
            await handle.writeFile(JSON.stringify(payload, null, 2) + "\n", "utf8");
        } finally {
            await handle.close();
        }
        return async () => {
            const current = await readLockInfo(lockPath);
            if (current?.pid === process.pid) {
                await removeLockFileBestEffort(lockPath);
            }
        };
    };

    try {
        return await create();
    } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;

        // The stale-lock removal path can race with another process that creates a new lock between
        // remove() and create(). Retry a small number of times before failing.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const info = await readLockInfo(lockPath);

            const holderPid = info?.pid ?? null;
            const holderAlive = holderPid != null ? isPidAlive(holderPid) : false;

            // Stale lock: remove and retry.
            if (!holderAlive) {
                await removeLockFileBestEffort(lockPath);
                try {
                    return await create();
                } catch (e: any) {
                    if (e?.code === "EEXIST") continue;
                    throw e;
                }
            }

            // PID reuse guard (best-effort):
            // If the current process with the same PID started *after* the lock file was created,
            // the lock is stale.
            const createdAtMs = (() => {
                try {
                    const d = new Date(info?.createdAt ?? "");
                    const t = d.getTime();
                    return Number.isFinite(t) ? t : null;
                } catch {
                    return null;
                }
            })();
            if (createdAtMs != null && holderPid != null) {
                const startMs = getProcessStartTimeMs(holderPid);
                if (startMs != null && startMs > createdAtMs + 1000) {
                    await removeLockFileBestEffort(lockPath);
                    try {
                        return await create();
                    } catch (e: any) {
                        if (e?.code === "EEXIST") continue;
                        throw e;
                    }
                }
            }

            const details =
                holderPid != null
                    ? `pid=${holderPid}${info?.purpose ? ` purpose=${info.purpose}` : ""}${info?.createdAt ? ` createdAt=${info.createdAt}` : ""}`
                    : "unknown owner";
            throw new Error(
                `[pglite] DB directory is already in use (${details}). ` +
                    `Stop the running server that uses this DB dir, then retry. ` +
                    `If you're sure nothing is running, delete the lock file: ${lockPath}`,
            );
        }

        const info = await readLockInfo(lockPath);
        const holderPid = info?.pid ?? null;
        const details =
            holderPid != null
                ? `pid=${holderPid}${info?.purpose ? ` purpose=${info.purpose}` : ""}${info?.createdAt ? ` createdAt=${info.createdAt}` : ""}`
                : "unknown owner";
        throw new Error(
            `[pglite] DB directory is already in use (${details}). ` +
                `Stop the running server that uses this DB dir, then retry. ` +
                `If you're sure nothing is running, delete the lock file: ${lockPath}`,
        );
    }
}
