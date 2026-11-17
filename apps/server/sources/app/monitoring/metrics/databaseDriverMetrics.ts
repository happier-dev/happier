import { Gauge, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

/**
 * Database driver metrics. Prisma 7 removed `$metrics`, so the storage owner reports the
 * statement durations and pool state it now owns, under the series names Prisma 6 exported
 * (the dashboards and alert rules in `apps/server/observability` read these names).
 */

export interface DatabasePoolStats {
    readonly open: number;
    readonly idle: number;
    readonly waiting: number;
}

let readPoolStats: (() => DatabasePoolStats | null) | null = null;

/** The runtime database client registers how to read its pool; read only when scraped. */
export function registerDatabasePoolStatsReader(reader: (() => DatabasePoolStats | null) | null): void {
    readPoolStats = reader;
}

function poolGauge(name: string, help: string, read: (stats: DatabasePoolStats) => number): Gauge {
    return getOrCreateMetric(name, () => new Gauge({
        name,
        help,
        registers: [register],
        collect() {
            const stats = readPoolStats?.() ?? null;
            if (stats) this.set(read(stats));
        },
    }));
}

export const databasePoolOpenGauge = poolGauge(
    "prisma_pool_connections_open", "Open database connections", (stats) => stats.open);
export const databasePoolIdleGauge = poolGauge(
    "prisma_pool_connections_idle", "Idle database connections", (stats) => stats.idle);
export const databasePoolBusyGauge = poolGauge(
    "prisma_pool_connections_busy", "Database connections running a query or transaction", (stats) => stats.open - stats.idle);
export const databaseQueriesWaitingGauge = poolGauge(
    "prisma_client_queries_wait", "Queries waiting for a database connection", (stats) => stats.waiting);

export const databaseQueryDurationHistogram = getOrCreateMetric("prisma_datasource_queries_duration_histogram_ms", () => new Histogram({
    name: "prisma_datasource_queries_duration_histogram_ms",
    help: "Duration of SQL statements sent to the database, in milliseconds",
    // Prisma 6's bucket boundaries, so existing quantile panels keep their resolution.
    buckets: [0, 1, 5, 10, 50, 100, 500, 1000, 5000, 50000],
    registers: [register],
}));
