import type { PrismaClientType } from "@/storage/prisma";
import { log } from "@/utils/logging/log";

// Active WAL checkpoint cadence for the light/sqlite server.
//
// Passive autocheckpoint can be starved indefinitely by long-lived / overlapping
// read transactions (e.g. session-message subscriptions). When that happens the
// WAL grows without bound, every read slows down as it scans WAL frames, and writes
// eventually exceed Prisma's query timeout and surface as `Socket timeout` errors —
// the server looks "crashed" while the CPU sits idle. An actively-driven
// `wal_checkpoint(TRUNCATE)` keeps the WAL bounded regardless of reader pressure.
const DEFAULT_WAL_CHECKPOINT_INTERVAL_MS = 60_000;

// `setInterval` stores its delay in a 32-bit signed int. A larger value is silently
// coerced to 1ms (with a TimeoutOverflowWarning), which would turn this into a hot loop.
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;

export type SqliteWalCheckpointResult = Readonly<{
    // SQLite returns 1 when the checkpoint could not run to completion because the
    // database was busy (e.g. a reader held the WAL), 0 otherwise.
    busy: number;
    // Size of the WAL log in frames before the checkpoint.
    logFrames: number;
    // Number of frames moved back into the database file.
    checkpointedFrames: number;
}>;

/**
 * Resolve the interval (ms) between active WAL checkpoints.
 *
 * Env: `HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS` / `HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS`
 *  - unset            -> default (60s)
 *  - "0"              -> disabled
 *  - positive integer -> that many ms
 */
export function resolveSqliteWalCheckpointIntervalMsFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = String(
        env.HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS ?? env.HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS ?? "",
    ).trim();
    if (!raw) return DEFAULT_WAL_CHECKPOINT_INTERVAL_MS;
    if (!/^\d+$/.test(raw)) {
        throw new Error(
            `Invalid HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS/HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: ${raw}`,
        );
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(
            `Invalid HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS/HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: ${raw}`,
        );
    }
    if (parsed > MAX_TIMER_INTERVAL_MS) {
        throw new Error(
            `HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS/HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS must be <= ${MAX_TIMER_INTERVAL_MS}: ${raw}`,
        );
    }
    return parsed;
}

/**
 * Run a single TRUNCATE checkpoint, resetting the WAL file to zero bytes when it can.
 * Returns SQLite's `(busy, log, checkpointed)` triple.
 */
export async function checkpointSqliteWal(client: PrismaClientType): Promise<SqliteWalCheckpointResult> {
    // `PRAGMA wal_checkpoint(TRUNCATE)` returns three integer columns documented as
    // (busy, log, checkpointed). Prefer SQLite's documented column names, falling back
    // to positional order, so we are robust to driver-specific result shaping either way.
    const rows = await client.$queryRawUnsafe<Array<Record<string, number | bigint>>>(
        "PRAGMA wal_checkpoint(TRUNCATE);",
    );
    const row = rows[0] ?? {};
    const positional = Object.values(row);
    const read = (name: string, index: number): number => Number(row[name] ?? positional[index] ?? 0);
    return {
        busy: read("busy", 0),
        logFrames: read("log", 1),
        checkpointedFrames: read("checkpointed", 2),
    };
}

export type SqliteWalCheckpointWorkerHandle = Readonly<{ stop: () => Promise<void> }>;

export type StartSqliteWalCheckpointWorkerOptions = Readonly<{
    client: PrismaClientType;
    intervalMs: number;
    // Injectable for tests; defaults to a real TRUNCATE checkpoint.
    runCheckpoint?: (client: PrismaClientType) => Promise<SqliteWalCheckpointResult>;
}>;

/**
 * Start a background worker that periodically issues `PRAGMA wal_checkpoint(TRUNCATE)`.
 *
 * Returns `null` when checkpointing is disabled (`intervalMs <= 0`). The returned
 * handle's `stop()` clears the timer and awaits any in-flight checkpoint so it is
 * safe to call during shutdown even though shutdown handlers run concurrently.
 */
export function startSqliteWalCheckpointWorker(
    options: StartSqliteWalCheckpointWorkerOptions,
): SqliteWalCheckpointWorkerHandle | null {
    if (options.intervalMs <= 0) {
        return null;
    }
    const runCheckpoint = options.runCheckpoint ?? checkpointSqliteWal;

    let stopped = false;
    let inFlight: Promise<void> | null = null;

    const run = async (): Promise<void> => {
        if (stopped || inFlight) return;
        inFlight = (async () => {
            try {
                const result = await runCheckpoint(options.client);
                if (result.busy !== 0) {
                    log(
                        { module: "storage", event: "sqlite-wal-checkpoint-busy", sqliteWalCheckpoint: result },
                        "SQLite WAL checkpoint could not fully complete (database busy)",
                    );
                }
            } catch (error) {
                log(
                    { module: "storage", event: "sqlite-wal-checkpoint-failed", error },
                    "SQLite WAL checkpoint failed",
                );
            } finally {
                inFlight = null;
            }
        })();
        await inFlight;
    };

    const timer = setInterval(() => {
        void run();
    }, options.intervalMs);
    timer.unref?.();

    return {
        stop: async () => {
            stopped = true;
            clearInterval(timer);
            if (inFlight) {
                await inFlight;
            }
        },
    };
}
