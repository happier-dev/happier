import type { SqliteMaintenanceClient } from "./prismaClientConstruction";
import { sqliteMaintenanceDurationHistogram } from "@/app/monitoring/metrics/databaseMetrics";
import { log } from "@/utils/logging/log";
import { onSqliteCommittedWrite } from "@/storage/sqliteCommittedWrites";

// Active WAL maintenance for the light/sqlite server, armed by committed writes.
//
// Passive autocheckpoint can be starved indefinitely by long-lived / overlapping
// read transactions (e.g. session-message subscriptions). When that happens the
// WAL grows without bound, every read slows down as it scans WAL frames, and writes
// can eventually exceed Prisma's query timeout and surface as `Socket timeout`
// errors. A committed write arms one maintenance pass an interval later; it first
// advances the WAL with a non-blocking PASSIVE checkpoint and requests a bounded
// TRUNCATE wait only when PASSIVE leaves a real uncheckpointed backlog (a reset-only
// wait can otherwise block the sole primary SQLite connection without making any
// additional frame progress). An idle database grows no WAL, so it runs nothing.
const DEFAULT_WAL_CHECKPOINT_INTERVAL_MS = 60_000;
const DEFAULT_WAL_CHECKPOINT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_INCREMENTAL_VACUUM_PAGES = 1_000;

// `setInterval` stores its delay in a 32-bit signed int. A larger value is silently
// coerced to 1ms (with a TimeoutOverflowWarning), which would turn this into a hot loop.
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;
// SQLite's busy timeout API also takes a signed 32-bit millisecond value.
const MAX_SQLITE_BUSY_TIMEOUT_MS = 2_147_483_647;
const MAX_SQLITE_INCREMENTAL_VACUUM_PAGES = 2_147_483_647;

function parseUnsignedIntegerEnv(params: Readonly<{
    env: NodeJS.ProcessEnv;
    primaryKey: string;
    legacyKey?: string;
    defaultValue: number;
    maxValue: number;
    allowZero: boolean;
}>): number {
    const raw = String(
        params.env[params.primaryKey] ?? (params.legacyKey ? params.env[params.legacyKey] : undefined) ?? "",
    ).trim();
    if (!raw) return params.defaultValue;
    if (!/^\d+$/.test(raw)) {
        throw new Error(`Invalid ${params.primaryKey}${params.legacyKey ? `/${params.legacyKey}` : ""}: ${raw}`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || (!params.allowZero && parsed < 1)) {
        throw new Error(`Invalid ${params.primaryKey}${params.legacyKey ? `/${params.legacyKey}` : ""}: ${raw}`);
    }
    if (parsed > params.maxValue) {
        throw new Error(
            `${params.primaryKey}${params.legacyKey ? `/${params.legacyKey}` : ""} must be <= ${params.maxValue}: ${raw}`,
        );
    }
    return parsed;
}

type SqliteMaintenanceQueries = Pick<SqliteMaintenanceClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

export type SqliteWalCheckpointResult = Readonly<{
    // SQLite returns 1 when the checkpoint could not run to completion because the
    // database was busy (e.g. a reader held the WAL), 0 otherwise.
    busy: number;
    // Number of frames in the WAL file.
    logFrames: number;
    // Total number of WAL frames that have been checkpointed, including frames
    // checkpointed before this invocation.
    checkpointedFrames: number;
}>;

/**
 * Resolve the delay (ms) between a committed write and the WAL maintenance it arms
 * (also the retry delay while the database stays busy).
 *
 * Env: `HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS` / `HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS`
 *  - unset            -> default (60s)
 *  - "0"              -> disabled
 *  - positive integer -> that many ms
 */
export function resolveSqliteWalCheckpointIntervalMsFromEnv(env: NodeJS.ProcessEnv): number {
    return parseUnsignedIntegerEnv({
        env,
        primaryKey: "HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS",
        legacyKey: "HAPPY_SQLITE_WAL_CHECKPOINT_INTERVAL_MS",
        defaultValue: DEFAULT_WAL_CHECKPOINT_INTERVAL_MS,
        maxValue: MAX_TIMER_INTERVAL_MS,
        allowZero: true,
    });
}

/**
 * Resolve how long a TRUNCATE checkpoint may wait for reader/writer gaps.
 *
 * Env: `HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS` / `HAPPY_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS`
 *  - unset            -> default (5s)
 *  - "0"              -> opportunistic only
 *  - positive integer -> that many ms
 */
export function resolveSqliteWalCheckpointBusyTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
    return parseUnsignedIntegerEnv({
        env,
        primaryKey: "HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS",
        legacyKey: "HAPPY_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS",
        defaultValue: DEFAULT_WAL_CHECKPOINT_BUSY_TIMEOUT_MS,
        maxValue: MAX_SQLITE_BUSY_TIMEOUT_MS,
        allowZero: true,
    });
}

/**
 * Whether the retention sweep reclaims SQLite free pages. Env:
 * `HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS` — "0" turns reclamation off; any other
 * valid value keeps it on (it runs with each retention sweep, so the value sets no cadence).
 */
export function isSqliteIncrementalVacuumEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
    return parseUnsignedIntegerEnv({
        env,
        primaryKey: "HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS",
        legacyKey: "HAPPY_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS",
        defaultValue: 1,
        maxValue: MAX_TIMER_INTERVAL_MS,
        allowZero: true,
    }) > 0;
}

export function resolveSqliteIncrementalVacuumPagesFromEnv(env: NodeJS.ProcessEnv): number {
    return parseUnsignedIntegerEnv({
        env,
        primaryKey: "HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES",
        legacyKey: "HAPPY_SQLITE_INCREMENTAL_VACUUM_PAGES",
        defaultValue: DEFAULT_INCREMENTAL_VACUUM_PAGES,
        maxValue: MAX_SQLITE_INCREMENTAL_VACUUM_PAGES,
        allowZero: false,
    });
}

async function runSqliteWalCheckpoint(
    client: SqliteMaintenanceQueries,
    mode: "PASSIVE" | "TRUNCATE",
): Promise<SqliteWalCheckpointResult> {
    // `PRAGMA wal_checkpoint` returns three integer columns documented as
    // (busy, log, checkpointed). Prefer SQLite's documented column names, falling back
    // to positional order, so we are robust to driver-specific result shaping either way.
    const rows = await client.$queryRawUnsafe(
        `PRAGMA wal_checkpoint(${mode});`,
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

/**
 * Run a single TRUNCATE checkpoint, resetting the WAL file to zero bytes when it can.
 * Returns SQLite's `(busy, log, checkpointed)` triple.
 */
export async function checkpointSqliteWal(client: SqliteMaintenanceQueries): Promise<SqliteWalCheckpointResult> {
    return runSqliteWalCheckpoint(client, "TRUNCATE");
}

/**
 * Advance WAL frames without invoking SQLite's busy handler first. A blocking reset
 * is useful only when PASSIVE could not checkpoint every frame; when all frames are
 * already checkpointed, SQLite can recycle the WAL after the reader gap on its own.
 */
export async function maintainSqliteWal(client: SqliteMaintenanceQueries): Promise<SqliteWalCheckpointResult> {
    const passive = await runSqliteWalCheckpoint(client, "PASSIVE");
    if (passive.logFrames <= passive.checkpointedFrames) {
        return passive;
    }
    return checkpointSqliteWal(client);
}

export type SqliteWalCheckpointWorkerHandle = Readonly<{ stop: () => Promise<void> }>;

export type StartSqliteWalCheckpointWorkerOptions = Readonly<{
    client: SqliteMaintenanceQueries;
    intervalMs: number;
    // Injectable for tests; defaults to PASSIVE-first maintenance with TRUNCATE only for backlog.
    runCheckpoint?: (client: SqliteMaintenanceQueries) => Promise<SqliteWalCheckpointResult>;
}>;

/**
 * Start WAL maintenance armed by committed writes (`sqliteCommittedWrites`): the first
 * write after a pass arms one PASSIVE-first pass `intervalMs` later; a busy result arms
 * a retry after the same delay. With no writes nothing is scheduled.
 *
 * Returns `null` when checkpointing is disabled (`intervalMs <= 0`). The returned
 * handle's `stop()` disarms and awaits any in-flight checkpoint.
 */
export function startSqliteWalCheckpointWorker(
    options: StartSqliteWalCheckpointWorkerOptions,
): SqliteWalCheckpointWorkerHandle | null {
    if (options.intervalMs <= 0) {
        return null;
    }
    const runCheckpoint = options.runCheckpoint ?? maintainSqliteWal;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let writtenDuringPass = false;
    let consecutiveBusyCount = 0;

    const arm = (): void => {
        if (stopped || timer) return;
        timer = setTimeout(() => {
            timer = null;
            void run();
        }, options.intervalMs);
        timer.unref?.();
    };

    const run = async (): Promise<void> => {
        if (stopped || inFlight) return;
        writtenDuringPass = false;
        inFlight = (async () => {
            const startedAtMs = Date.now();
            let outcome = "error";
            let retry = false;
            try {
                const result = await runCheckpoint(options.client);
                if (result.busy !== 0) {
                    consecutiveBusyCount += 1;
                    retry = true;
                    outcome = result.logFrames > 0 && result.logFrames === result.checkpointedFrames
                        ? "wal-reset-deferred"
                        : "checkpoint-incomplete";
                    log(
                        {
                            module: "storage",
                            event: "sqlite-wal-checkpoint-busy",
                            sqliteWalCheckpoint: {
                                ...result,
                                outcome,
                                durationMs: Date.now() - startedAtMs,
                                retryIntervalMs: options.intervalMs,
                                consecutiveBusyCount,
                            },
                        },
                        outcome === "wal-reset-deferred"
                            ? "SQLite WAL frames were checkpointed, but the WAL reset was deferred because the database is busy; retry scheduled"
                            : "SQLite WAL checkpoint was incomplete because the database is busy; retry scheduled",
                    );
                } else {
                    consecutiveBusyCount = 0;
                    outcome = "ok";
                }
            } catch (error) {
                consecutiveBusyCount = 0;
                log(
                    { module: "storage", event: "sqlite-wal-checkpoint-failed", error },
                    "SQLite WAL checkpoint failed",
                );
            } finally {
                sqliteMaintenanceDurationHistogram.observe(
                    { operation: "wal_checkpoint", outcome },
                    (Date.now() - startedAtMs) / 1_000,
                );
                inFlight = null;
                if (retry || writtenDuringPass) arm();
            }
        })();
    };

    const unsubscribe = onSqliteCommittedWrite(() => {
        if (inFlight) {
            writtenDuringPass = true;
            return;
        }
        arm();
    });

    return {
        stop: async () => {
            stopped = true;
            unsubscribe();
            if (timer) clearTimeout(timer);
            timer = null;
            if (inFlight) {
                await inFlight;
            }
        },
    };
}

export async function incrementalVacuumSqlite(client: SqliteMaintenanceQueries, pages: number): Promise<void> {
    const normalizedPages = parseUnsignedIntegerEnv({
        env: { HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: String(pages) },
        primaryKey: "HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES",
        defaultValue: DEFAULT_INCREMENTAL_VACUUM_PAGES,
        maxValue: MAX_SQLITE_INCREMENTAL_VACUUM_PAGES,
        allowZero: false,
    });
    await client.$executeRawUnsafe(`PRAGMA incremental_vacuum(${normalizedPages});`);
}

/**
 * One bounded incremental-vacuum batch, run by the hourly retention sweep after it
 * deletes rows (the only time free pages appear). Failures are logged and observed;
 * the next sweep tries again.
 */
export async function reclaimSqliteFreePages(client: SqliteMaintenanceQueries, pages: number): Promise<void> {
    const startedAtMs = Date.now();
    let outcome = "error";
    try {
        await incrementalVacuumSqlite(client, pages);
        outcome = "ok";
    } catch (error) {
        log(
            { module: "storage", event: "sqlite-incremental-vacuum-failed", error },
            "SQLite incremental vacuum failed",
        );
    } finally {
        sqliteMaintenanceDurationHistogram.observe(
            { operation: "incremental_vacuum", outcome },
            (Date.now() - startedAtMs) / 1_000,
        );
    }
}
