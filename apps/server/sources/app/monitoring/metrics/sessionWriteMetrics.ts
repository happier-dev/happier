import { Counter, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

type CreateSessionMessageStage = "access" | "persist" | "change_tracking" | "total";
type CreateSessionMessageResult = "ok" | "error";

export const createSessionMessageDurationHistogram = getOrCreateMetric("session_write_create_message_duration_seconds", () => new Histogram({
    name: "session_write_create_message_duration_seconds",
    help: "Create-session-message duration by pre-ack stage",
    labelNames: ["stage", "result"] as const,
    buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
    registers: [register],
}));

export const databaseTransactionRetriesCounter = getOrCreateMetric("database_transaction_retries_total", () => new Counter({
    name: "database_transaction_retries_total",
    help: "Total retried database transactions by provider",
    labelNames: ["provider"] as const,
    registers: [register],
}));

export const sessionMessageRoleMismatchCounter = getOrCreateMetric("session_message_role_mismatch_total", () => new Counter({
    name: "session_message_role_mismatch_total",
    help: "Total session message role mismatches between supplied metadata and derived plaintext content",
    labelNames: ["supplied_role", "derived_role", "final_role", "content_kind", "storage_mode", "source"] as const,
    registers: [register],
}));

export function observeCreateSessionMessageStage(params: Readonly<{
    stage: CreateSessionMessageStage;
    durationMs: number;
    result: CreateSessionMessageResult;
}>): void {
    createSessionMessageDurationHistogram.observe(
        { stage: params.stage, result: params.result },
        params.durationMs / 1000,
    );
}

export function recordDatabaseTransactionRetry(provider: string): void {
    databaseTransactionRetriesCounter.inc({ provider });
}
