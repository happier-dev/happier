import { getRedisClient } from "@/storage/redis/redis";
import { PresenceBatcher } from "./presenceBatcher";
import { db } from "@/storage/db";
import { forever } from "@/utils/runtime/forever";
import { delay } from "@/utils/runtime/delay";
import { shutdownSignal } from "@/utils/process/shutdown";
import { log } from "@/utils/logging/log";
import { randomUUID } from "node:crypto";
import { readPresenceRedisWorkerConfigFromEnv, readPresenceStreamConfigFromEnv } from "@/config/presence";
import {
    observePresenceStreamFlush,
    recordPresenceStreamAck,
    recordPresenceStreamInvalidEntry,
    recordPresenceStreamRedisPendingRefreshFailure,
    recordPresenceStreamRead,
    recordPresenceStreamReclaim,
    setPresenceStreamPendingEntries,
    setPresenceStreamRedisPendingEntries,
} from "@/app/monitoring/metrics/index";

const STREAM_KEY = "presence:alive:v1";
const GROUP = "presence-worker";

type PresenceKind = "session" | "machine";

async function runWithConcurrencyLimit<T>(
    items: readonly T[],
    concurrency: number,
    iteratee: (item: T) => Promise<void>,
): Promise<void> {
    if (items.length === 0) {
        return;
    }

    let index = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                const currentIndex = index;
                index += 1;
                if (currentIndex >= items.length) {
                    return;
                }
                await iteratee(items[currentIndex]);
            }
        }),
    );
}

function getStreamMaxLen(env: NodeJS.ProcessEnv): number | null {
    return readPresenceStreamConfigFromEnv(env).streamMaxLen;
}

function getConsumerName(env: NodeJS.ProcessEnv): string {
    // Must be stable per-process; `HAPPY_INSTANCE_ID` is also used for cluster-aware RPC.
    return env.HAPPIER_INSTANCE_ID?.trim() || env.HAPPY_INSTANCE_ID?.trim() || `worker:${process.pid}:${randomUUID()}`;
}

export async function publishSessionAlive(params: { sessionId: string; timestamp: number; accountId?: string | null }): Promise<void> {
    const redis = getRedisClient();
    const maxLen = getStreamMaxLen(process.env);
    const maxLenArgs = maxLen ? (["MAXLEN", "~", String(maxLen)] as const) : ([] as const);
    await redis.xadd(
        STREAM_KEY,
        ...maxLenArgs,
        "*",
        "kind",
        "session",
        "id",
        params.sessionId,
        "ts",
        params.timestamp.toString(),
        "accountId",
        params.accountId ?? "",
    );
}

export async function publishMachineAlive(params: { accountId: string; machineId: string; timestamp: number }): Promise<void> {
    const redis = getRedisClient();
    const maxLen = getStreamMaxLen(process.env);
    const maxLenArgs = maxLen ? (["MAXLEN", "~", String(maxLen)] as const) : ([] as const);
    await redis.xadd(
        STREAM_KEY,
        ...maxLenArgs,
        "*",
        "kind",
        "machine",
        "id",
        params.machineId,
        "ts",
        params.timestamp.toString(),
        "accountId",
        params.accountId,
    );
}

async function ensureGroupExists(): Promise<void> {
    const redis = getRedisClient();
    try {
        // MKSTREAM creates the stream if it does not exist.
        await redis.xgroup("CREATE", STREAM_KEY, GROUP, "$", "MKSTREAM");
    } catch (e: any) {
        const msg = typeof e?.message === "string" ? e.message : "";
        if (msg.includes("BUSYGROUP")) return;
        throw e;
    }
}

function parseFields(fields: Array<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) {
        out[fields[i]] = fields[i + 1];
    }
    return out;
}

async function flushBatch(batcher: PresenceBatcher, dbWriteConcurrency: number): Promise<void> {
    const startedAt = Date.now();
    const snapshot = batcher.snapshot();
    const { sessions, machines } = snapshot;

    if (sessions.length > 0) {
        await runWithConcurrencyLimit(
            sessions,
            dbWriteConcurrency,
            async (sessionPresence) => {
                try {
                    await db.session.updateMany({
                        where: {
                            id: sessionPresence.sessionId,
                            accountId: sessionPresence.accountId,
                        },
                        data: { lastActiveAt: new Date(sessionPresence.timestamp), active: true },
                    });
                } catch (error) {
                    // Presence is best-effort; ignore missing/deleted entities and keep the worker alive.
                    log(
                        { module: "presence-redis-worker", level: "warn" },
                        `Session presence update failed: ${error}`,
                    );
                }
            },
        );
    }

    if (machines.length > 0) {
        await runWithConcurrencyLimit(
            machines,
            dbWriteConcurrency,
            async (machinePresence) => {
                try {
                    await db.machine.updateMany({
                        where: {
                            accountId: machinePresence.accountId,
                            id: machinePresence.machineId,
                            revokedAt: null,
                        },
                        data: { lastActiveAt: new Date(machinePresence.timestamp), active: true },
                    });
                } catch (error) {
                    log(
                        { module: "presence-redis-worker", level: "warn" },
                        `Machine presence update failed: ${error}`,
                    );
                }
            },
        );
    }

    batcher.commit(snapshot);
    observePresenceStreamFlush({
        durationMs: Date.now() - startedAt,
        sessionCount: sessions.length,
        machineCount: machines.length,
    });
}

async function refreshRedisPendingEntries(redis: ReturnType<typeof getRedisClient>): Promise<void> {
    try {
        const summary = await (redis as any).xpending(STREAM_KEY, GROUP);
        const count = Array.isArray(summary) ? Number(summary[0]) : 0;
        setPresenceStreamRedisPendingEntries(Number.isFinite(count) ? count : 0);
    } catch {
        recordPresenceStreamRedisPendingRefreshFailure();
    }
}

export function startPresenceRedisWorker(params?: {
    dbWriteConcurrency?: number;
    flushIntervalMs?: number;
    readBlockMs?: number;
    readCount?: number;
    consumerName?: string;
    reclaimIdleMs?: number;
}): { stop: () => Promise<void> } {
    const defaults = readPresenceRedisWorkerConfigFromEnv(process.env);
    const dbWriteConcurrency = params?.dbWriteConcurrency ?? defaults.dbWriteConcurrency;
    const flushIntervalMs = params?.flushIntervalMs ?? defaults.flushIntervalMs;
    const readBlockMs = params?.readBlockMs ?? defaults.readBlockMs;
    const readCount = params?.readCount ?? defaults.readCount;
    const reclaimIdleMs = params?.reclaimIdleMs ?? defaults.reclaimIdleMs;

    const redis = getRedisClient();
    const batcher = new PresenceBatcher();
    let flushTimer: NodeJS.Timeout | null = null;
    const consumerName = params?.consumerName ?? getConsumerName(process.env);
    const pendingAckIds: string[] = [];
    let lastReclaimAt = 0;

    const startTimer = () => {
        flushTimer = setInterval(() => {
            flushBatch(batcher, dbWriteConcurrency)
                .then(async () => {
                    if (pendingAckIds.length === 0) return;
                    const ids = pendingAckIds.splice(0, pendingAckIds.length);
                    await redis.xack(STREAM_KEY, GROUP, ...ids);
                    recordPresenceStreamAck(ids.length);
                    setPresenceStreamPendingEntries(pendingAckIds.length);
                    await refreshRedisPendingEntries(redis);
                })
                .catch((e) => {
                log({ module: "presence-redis-worker", level: "error" }, `Error flushing presence batch: ${e}`);
            });
        }, flushIntervalMs);
        flushTimer.unref?.();
    };

    const stop = async () => {
        if (flushTimer) {
            clearInterval(flushTimer);
            flushTimer = null;
        }
        await flushBatch(batcher, dbWriteConcurrency);
        if (pendingAckIds.length > 0) {
            const ids = pendingAckIds.splice(0, pendingAckIds.length);
            await redis.xack(STREAM_KEY, GROUP, ...ids);
            recordPresenceStreamAck(ids.length);
        }
        setPresenceStreamPendingEntries(pendingAckIds.length);
        await refreshRedisPendingEntries(redis);
    };

    void forever("presence-redis-worker", async () => {
        await ensureGroupExists();
        if (!flushTimer) startTimer();

        while (!shutdownSignal.aborted) {
            // Reclaim stuck pending entries from crashed workers.
            const now = Date.now();
            if (now - lastReclaimAt > reclaimIdleMs) {
                lastReclaimAt = now;
                try {
                    const res = await (redis as any).xautoclaim(
                        STREAM_KEY,
                        GROUP,
                        consumerName,
                        reclaimIdleMs,
                        "0-0",
                        "COUNT",
                        readCount,
                    );
                    const entries = Array.isArray(res) ? res[1] : [];
                    recordPresenceStreamReclaim(entries.length);
                    recordPresenceStreamRead("reclaim", entries.length);
                    for (const [id, fields] of entries as any[]) {
                        const map = parseFields(fields as any);
                        const kind = map.kind as PresenceKind | undefined;
                        const entityId = map.id;
                        const ts = Number(map.ts);
                        const accountId = map.accountId || "";

                        if (!kind || !entityId || !Number.isFinite(ts)) {
                            recordPresenceStreamInvalidEntry();
                            pendingAckIds.push(id);
                            setPresenceStreamPendingEntries(pendingAckIds.length);
                            continue;
                        }

                        if (kind === "session" && accountId) {
                            batcher.recordSessionAlive(accountId, entityId, ts);
                        } else if (kind === "machine" && accountId) {
                            batcher.recordMachineAlive(accountId, entityId, ts);
                        }

                        pendingAckIds.push(id);
                        setPresenceStreamPendingEntries(pendingAckIds.length);
                    }
                    await refreshRedisPendingEntries(redis);
                } catch (e) {
                    // Best-effort: do not kill the worker if reclaim fails.
                    log({ module: "presence-redis-worker", level: "warn" }, `Presence reclaim failed: ${e}`);
                }
            }

            const res = await redis.xreadgroup(
                "GROUP",
                GROUP,
                consumerName,
                "COUNT",
                readCount,
                "BLOCK",
                readBlockMs,
                "STREAMS",
                STREAM_KEY,
                ">",
            );

            if (!res) {
                await delay(1, shutdownSignal);
                continue;
            }

            let readEntryCount = 0;
            for (const [, entries] of res as any) {
                readEntryCount += Array.isArray(entries) ? entries.length : 0;
                for (const [id, fields] of entries as any[]) {
                    const map = parseFields(fields as any);
                    const kind = map.kind as PresenceKind | undefined;
                    const entityId = map.id;
                    const ts = Number(map.ts);
                    const accountId = map.accountId || "";

                    if (!kind || !entityId || !Number.isFinite(ts)) {
                        recordPresenceStreamInvalidEntry();
                        pendingAckIds.push(id);
                        setPresenceStreamPendingEntries(pendingAckIds.length);
                        continue;
                    }

                    if (kind === "session" && accountId) {
                        batcher.recordSessionAlive(accountId, entityId, ts);
                    } else if (kind === "machine" && accountId) {
                        batcher.recordMachineAlive(accountId, entityId, ts);
                    }

                    pendingAckIds.push(id);
                    setPresenceStreamPendingEntries(pendingAckIds.length);
                }
            }
            recordPresenceStreamRead("stream", readEntryCount);
            await refreshRedisPendingEntries(redis);
        }
    });

    return { stop };
}
