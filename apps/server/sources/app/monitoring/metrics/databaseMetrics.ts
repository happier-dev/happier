import { Counter, Gauge } from "prom-client";

import { db } from "@/storage/db";
import { delay } from "@/utils/runtime/delay";
import { shutdownSignal } from "@/utils/process/shutdown";
import { forever } from "@/utils/runtime/forever";

import { register } from "./registry";

export const databaseRecordCountGauge = new Gauge({
    name: "database_records_total",
    help: "Total number of records in database tables",
    labelNames: ["table"] as const,
    registers: [register],
});

export const databaseMetricsUpdateFailuresCounter = new Counter({
    name: "database_metrics_update_failures_total",
    help: "Total database metrics update failures",
    registers: [register],
});

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

export function startDatabaseMetricsUpdater(): void {
    void forever("database-metrics-updater", async () => {
        try {
            await updateDatabaseMetrics();
        } catch {
            databaseMetricsUpdateFailuresCounter.inc();
        }

        await delay(60 * 1000, shutdownSignal);
    });
}
