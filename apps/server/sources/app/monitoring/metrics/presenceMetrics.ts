import { Counter, Gauge, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

export const sessionAliveEventsCounter = getOrCreateMetric("session_alive_events_total", () => new Counter({
    name: "session_alive_events_total",
    help: "Total number of session-alive events",
    registers: [register],
}));

export const machineAliveEventsCounter = getOrCreateMetric("machine_alive_events_total", () => new Counter({
    name: "machine_alive_events_total",
    help: "Total number of machine-alive events",
    registers: [register],
}));

export const sessionCacheCounter = getOrCreateMetric("session_cache_operations_total", () => new Counter({
    name: "session_cache_operations_total",
    help: "Total session cache operations",
    labelNames: ["operation", "result"] as const,
    registers: [register],
}));

export const databaseUpdatesSkippedCounter = getOrCreateMetric("database_updates_skipped_total", () => new Counter({
    name: "database_updates_skipped_total",
    help: "Number of database updates skipped due to debouncing",
    labelNames: ["type"] as const,
    registers: [register],
}));

export const presenceStreamReadsCounter = getOrCreateMetric("presence_stream_reads_total", () => new Counter({
    name: "presence_stream_reads_total",
    help: "Total presence stream entries read by source",
    labelNames: ["source"] as const,
    registers: [register],
}));

export const presenceStreamBatchSizeHistogram = getOrCreateMetric("presence_stream_batch_size", () => new Histogram({
    name: "presence_stream_batch_size",
    help: "Presence batch size written during a flush",
    labelNames: ["kind"] as const,
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
    registers: [register],
}));

export const presenceStreamReclaimsCounter = getOrCreateMetric("presence_stream_reclaims_total", () => new Counter({
    name: "presence_stream_reclaims_total",
    help: "Total number of reclaimed pending presence entries",
    registers: [register],
}));

export const presenceStreamInvalidEntriesCounter = getOrCreateMetric("presence_stream_invalid_entries_total", () => new Counter({
    name: "presence_stream_invalid_entries_total",
    help: "Total invalid presence stream entries skipped by the worker",
    registers: [register],
}));

export const presenceStreamAckCounter = getOrCreateMetric("presence_stream_acks_total", () => new Counter({
    name: "presence_stream_acks_total",
    help: "Total presence stream acknowledgements emitted by the worker",
    registers: [register],
}));

export const presenceStreamLastFlushDurationGauge = getOrCreateMetric("presence_stream_last_flush_duration_seconds", () => new Gauge({
    name: "presence_stream_last_flush_duration_seconds",
    help: "Duration in seconds of the most recent presence flush",
    registers: [register],
}));

export const presenceStreamPendingEntriesGauge = getOrCreateMetric("presence_stream_pending_entries", () => new Gauge({
    name: "presence_stream_pending_entries",
    help: "Current in-process pending presence entries awaiting acknowledgement",
    registers: [register],
}));

export const presenceStreamRedisPendingEntriesGauge = getOrCreateMetric("presence_stream_redis_pending_entries", () => new Gauge({
    name: "presence_stream_redis_pending_entries",
    help: "Current Redis consumer-group pending presence entries awaiting acknowledgement",
    registers: [register],
}));

export const presenceStreamRedisPendingRefreshFailuresCounter = getOrCreateMetric("presence_stream_redis_pending_refresh_failures_total", () => new Counter({
    name: "presence_stream_redis_pending_refresh_failures_total",
    help: "Total failures while refreshing Redis-backed pending presence depth",
    registers: [register],
}));

export const presenceFlushRetriesCounter = getOrCreateMetric("presence_flush_retries_total", () => new Counter({
    name: "presence_flush_retries_total",
    help: "Total presence flush retries triggered by failed or backed-off DB writes",
    labelNames: ["entity_type", "reason"] as const,
    registers: [register],
}));

export function recordPresenceStreamRead(source: "reclaim" | "stream", entryCount: number): void {
    if (entryCount <= 0) {
        return;
    }
    presenceStreamReadsCounter.inc({ source }, entryCount);
}

export function recordPresenceStreamReclaim(entryCount: number): void {
    if (entryCount <= 0) {
        return;
    }
    presenceStreamReclaimsCounter.inc(entryCount);
}

export function recordPresenceStreamInvalidEntry(): void {
    presenceStreamInvalidEntriesCounter.inc();
}

export function recordPresenceStreamAck(entryCount: number): void {
    if (entryCount <= 0) {
        return;
    }
    presenceStreamAckCounter.inc(entryCount);
}

export function observePresenceStreamFlush(params: Readonly<{
    durationMs: number;
    sessionCount: number;
    machineCount: number;
}>): void {
    presenceStreamLastFlushDurationGauge.set(params.durationMs / 1000);
    if (params.sessionCount > 0) {
        presenceStreamBatchSizeHistogram.observe({ kind: "session" }, params.sessionCount);
    }
    if (params.machineCount > 0) {
        presenceStreamBatchSizeHistogram.observe({ kind: "machine" }, params.machineCount);
    }
}

export function setPresenceStreamPendingEntries(count: number): void {
    presenceStreamPendingEntriesGauge.set(Math.max(0, count));
}

export function setPresenceStreamRedisPendingEntries(count: number): void {
    presenceStreamRedisPendingEntriesGauge.set(Math.max(0, count));
}

export function recordPresenceStreamRedisPendingRefreshFailure(): void {
    presenceStreamRedisPendingRefreshFailuresCounter.inc();
}

export function recordPresenceFlushRetry(params: Readonly<{
    entityType: "session" | "machine";
    reason: "db-error" | "db-backoff";
}>): void {
    presenceFlushRetriesCounter.inc({
        entity_type: params.entityType,
        reason: params.reason,
    });
}
