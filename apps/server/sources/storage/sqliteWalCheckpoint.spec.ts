import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaClientType } from "@/storage/prisma";
import {
    checkpointSqliteWal,
    resolveSqliteWalCheckpointBusyTimeoutMsFromEnv,
    resolveSqliteWalCheckpointIntervalMsFromEnv,
    startSqliteWalCheckpointWorker,
    type SqliteWalCheckpointResult,
} from "@/storage/sqliteWalCheckpoint";

// The worker only forwards this to the injected runCheckpoint, so a sentinel is enough.
const client = {} as unknown as PrismaClientType;
const ok: SqliteWalCheckpointResult = { busy: 0, logFrames: 0, checkpointedFrames: 0 };

describe("resolveSqliteWalCheckpointIntervalMsFromEnv", () => {
    it("defaults to 60s when unset", () => {
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({})).toBe(60_000);
    });

    it("treats 0 as disabled", () => {
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "0" })).toBe(0);
    });

    it("reads an explicit interval and the HAPPY_ alias", () => {
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "5000" })).toBe(5000);
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "1500" })).toBe(1500);
    });

    it("rejects non-numeric values", () => {
        expect(() => resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "soon" })).toThrow();
    });

    it("rejects values that are not safe integers", () => {
        expect(() =>
            resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "99999999999999999999" }),
        ).toThrow();
    });

    it("rejects intervals beyond the 32-bit setInterval bound", () => {
        expect(resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "2147483647" })).toBe(
            2_147_483_647,
        );
        expect(() =>
            resolveSqliteWalCheckpointIntervalMsFromEnv({ HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: "2147483648" }),
        ).toThrow();
    });
});

describe("resolveSqliteWalCheckpointBusyTimeoutMsFromEnv", () => {
    it("defaults to a bounded wait for reader gaps", () => {
        expect(resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({})).toBe(5_000);
    });

    it("reads an explicit timeout and the HAPPY_ alias", () => {
        expect(resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
            HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "2500",
        })).toBe(2500);
        expect(resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
            HAPPY_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "1500",
        })).toBe(1500);
    });

    it("allows 0 for an explicitly opportunistic checkpoint", () => {
        expect(resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
            HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "0",
        })).toBe(0);
    });

    it("rejects invalid or unsafe timeout values", () => {
        expect(() =>
            resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
                HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "soon",
            }),
        ).toThrow();
        expect(() =>
            resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
                HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "99999999999999999999",
            }),
        ).toThrow();
        expect(() =>
            resolveSqliteWalCheckpointBusyTimeoutMsFromEnv({
                HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: "2147483648",
            }),
        ).toThrow();
    });
});

describe("checkpointSqliteWal", () => {
    it("reads documented SQLite column names first", async () => {
        const fakeClient = {
            $queryRawUnsafe: vi.fn(async () => [{ busy: 1n, log: 7n, checkpointed: 3n }]),
        } as unknown as PrismaClientType;

        await expect(checkpointSqliteWal(fakeClient)).resolves.toEqual({
            busy: 1,
            logFrames: 7,
            checkpointedFrames: 3,
        });
    });

    it("falls back to positional column order for driver-shaped rows", async () => {
        const fakeClient = {
            $queryRawUnsafe: vi.fn(async () => [{ 0: 0, 1: 11, 2: 9 }]),
        } as unknown as PrismaClientType;

        await expect(checkpointSqliteWal(fakeClient)).resolves.toEqual({
            busy: 0,
            logFrames: 11,
            checkpointedFrames: 9,
        });
    });
});

describe("startSqliteWalCheckpointWorker", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns null when disabled", () => {
        expect(startSqliteWalCheckpointWorker({ client, intervalMs: 0, runCheckpoint: async () => ok })).toBeNull();
    });

    it("checkpoints once per interval and stops after stop()", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const handle = startSqliteWalCheckpointWorker({
            client,
            intervalMs: 1000,
            runCheckpoint: async () => {
                calls += 1;
                return ok;
            },
        });
        expect(handle).not.toBeNull();

        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls).toBe(2);

        await handle!.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(calls).toBe(2);
    });

    it("does not overlap checkpoints when one is slower than the interval", async () => {
        vi.useFakeTimers();
        let started = 0;
        const releases: Array<() => void> = [];

        const handle = startSqliteWalCheckpointWorker({
            client,
            intervalMs: 1000,
            runCheckpoint: async () => {
                started += 1;
                await new Promise<void>((resolve) => {
                    releases.push(resolve);
                });
                return ok;
            },
        });

        await vi.advanceTimersByTimeAsync(1000); // run #1 starts, blocks on its gate
        expect(started).toBe(1);
        await vi.advanceTimersByTimeAsync(1000); // tick again: in-flight, must skip
        expect(started).toBe(1);

        releases[0](); // let run #1 finish
        await vi.advanceTimersByTimeAsync(1000); // next tick runs #2
        expect(started).toBe(2);

        releases.forEach((release) => release());
        await handle!.stop();
    });

    it("stop() waits for an in-flight checkpoint", async () => {
        vi.useFakeTimers();
        let finished = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const handle = startSqliteWalCheckpointWorker({
            client,
            intervalMs: 1000,
            runCheckpoint: async () => {
                await gate;
                finished = true;
                return ok;
            },
        });

        await vi.advanceTimersByTimeAsync(1000); // run in flight, blocked on gate
        let stopResolved = false;
        const stopPromise = handle!.stop().then(() => {
            stopResolved = true;
        });
        await Promise.resolve();
        expect(stopResolved).toBe(false); // still awaiting the in-flight checkpoint
        expect(finished).toBe(false);

        release();
        await stopPromise;
        expect(finished).toBe(true);
    });
});
