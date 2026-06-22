import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaClientType } from "@/storage/prisma";
import {
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
