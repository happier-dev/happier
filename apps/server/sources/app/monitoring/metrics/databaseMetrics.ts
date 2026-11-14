import { Counter, Gauge, Histogram } from "prom-client";

import { db } from "@/storage/db";

import { getOrCreateMetric, register } from "./registry";

/** Exact counts are taken only when enabled (metrics endpoint on, concurrent database). */
let databaseRecordCountsEnabled = false;

export const databaseRecordCountGauge = getOrCreateMetric("database_records_total", () => new Gauge({
    name: "database_records_total",
    help: "Total number of records in database tables",
    labelNames: ["table"] as const,
    registers: [register],
    // Counted when scraped, so an unscraped server issues no COUNT(*) statements.
    async collect() {
        if (!databaseRecordCountsEnabled) return;
        try {
            await updateDatabaseMetrics();
        } catch {
            databaseMetricsUpdateFailuresCounter.inc();
        }
    },
}));

export const databaseMetricsUpdateFailuresCounter = getOrCreateMetric("database_metrics_update_failures_total", () => new Counter({
    name: "database_metrics_update_failures_total",
    help: "Total database metrics update failures",
    registers: [register],
}));

export const dbReadinessChecksCounter = getOrCreateMetric("db_readiness_checks_total", () => new Counter({
    name: "db_readiness_checks_total",
    help: "Total database readiness checks by result and reason",
    labelNames: ["result", "reason"] as const,
    registers: [register],
}));

export const dbReadinessDurationHistogram = getOrCreateMetric("db_readiness_duration_seconds", () => new Histogram({
    name: "db_readiness_duration_seconds",
    help: "Database readiness check duration in seconds",
    labelNames: ["result", "reason"] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register],
}));

export const sqliteMaintenanceDurationHistogram = getOrCreateMetric("sqlite_maintenance_duration_seconds", () => new Histogram({
    name: "sqlite_maintenance_duration_seconds",
    help: "SQLite maintenance duration by operation and outcome",
    labelNames: ["operation", "outcome"] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
    registers: [register],
}));

export async function updateDatabaseMetrics(): Promise<void> {
    const [accountCount, sessionCount, messageCount, machineCount] = await Promise.all([
        db.account.count(),
        db.session.count(),
        db.sessionMessage.count(),
        db.machine.count(),
    ]);

    databaseRecordCountGauge.set({ table: "accounts" }, accountCount);
    databaseRecordCountGauge.set({ table: "sessions" }, sessionCount);
    databaseRecordCountGauge.set({ table: "messages" }, messageCount);
    databaseRecordCountGauge.set({ table: "machines" }, machineCount);
}

export function enableDatabaseRecordCountsOnScrape(): void {
    databaseRecordCountsEnabled = true;
}
