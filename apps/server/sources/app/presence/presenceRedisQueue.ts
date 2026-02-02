import { getRedisClient } from "@/storage/redis";
import { PresenceBatcher } from "./presenceBatcher";
import { db } from "@/storage/db";
import { forever } from "@/utils/forever";
import { delay } from "@/utils/delay";
import { shutdownSignal } from "@/utils/shutdown";
import { log } from "@/utils/log";
import { randomUUID } from "node:crypto";

const STREAM_KEY = "presence:alive:v1";
const GROUP = "presence-worker";
const DEFAULT_MAXLEN = 100_000;
const DEFAULT_RECLAIM_IDLE_MS = 60_000;

type PresenceKind = "session" | "machine";

function getStreamMaxLen(env: NodeJS.ProcessEnv): number | null {
    const raw = env.HAPPY_PRESENCE_STREAM_MAXLEN?.trim();
    if (!raw) return DEFAULT_MAXLEN;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_MAXLEN;
    if (n === 0) return null;
    return Math.floor(n);
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

async function flushBatch(batcher: PresenceBatcher): Promise<void> {
    const snapshot = batcher.snapshot();
    const { sessions, machines } = snapshot;

    if (sessions.length > 0) {
        const results = await Promise.allSettled(
            sessions.map((s) =>
                db.session.update({
                    where: { id: s.sessionId },
                    data: { lastActiveAt: new Date(s.timestamp), active: true },
                }),
            ),
        );
        for (const r of results) {
            if (r.status === "rejected") {
                // Presence is best-effort; ignore missing/deleted entities and keep the worker alive.
                log({ module: "presence-redis-worker", level: "warn" }, `Session presence update failed: ${r.reason}`);
            }
        }
    }

    if (machines.length > 0) {
        const results = await Promise.allSettled(
            machines.map((m) =>
                db.machine.update({
                    where: { accountId_id: { accountId: m.accountId, id: m.machineId } },
                    data: { lastActiveAt: new Date(m.timestamp), active: true },
                }),
            ),
        );
        for (const r of results) {
            if (r.status === "rejected") {
                log({ module: "presence-redis-worker", level: "warn" }, `Machine presence update failed: ${r.reason}`);
            }
        }
    }

    batcher.commit(snapshot);
}

export function startPresenceRedisWorker(params?: {
    flushIntervalMs?: number;
    readBlockMs?: number;
    readCount?: number;
    consumerName?: string;
    reclaimIdleMs?: number;
}): { stop: () => Promise<void> } {
    const flushIntervalMs = params?.flushIntervalMs ?? 5000;
    const readBlockMs = params?.readBlockMs ?? 5000;
    const readCount = params?.readCount ?? 200;
    const reclaimIdleMs = params?.reclaimIdleMs ?? DEFAULT_RECLAIM_IDLE_MS;

    const redis = getRedisClient();
    const batcher = new PresenceBatcher();
    let flushTimer: NodeJS.Timeout | null = null;
    const consumerName = params?.consumerName ?? getConsumerName(process.env);
    const pendingAckIds: string[] = [];
    let lastReclaimAt = 0;

    const startTimer = () => {
        flushTimer = setInterval(() => {
            flushBatch(batcher)
                .then(async () => {
                    if (pendingAckIds.length === 0) return;
                    const ids = pendingAckIds.splice(0, pendingAckIds.length);
                    await redis.xack(STREAM_KEY, GROUP, ...ids);
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
        await flushBatch(batcher);
        if (pendingAckIds.length > 0) {
            const ids = pendingAckIds.splice(0, pendingAckIds.length);
            await redis.xack(STREAM_KEY, GROUP, ...ids);
        }
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
                    for (const [id, fields] of entries as any[]) {
                        const map = parseFields(fields as any);
                        const kind = map.kind as PresenceKind | undefined;
                        const entityId = map.id;
                        const ts = Number(map.ts);
                        const accountId = map.accountId || "";

                        if (!kind || !entityId || !Number.isFinite(ts)) {
                            pendingAckIds.push(id);
                            continue;
                        }

                        if (kind === "session") {
                            batcher.recordSessionAlive(entityId, ts);
                        } else if (kind === "machine" && accountId) {
                            batcher.recordMachineAlive(accountId, entityId, ts);
                        }

                        pendingAckIds.push(id);
                    }
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

            for (const [, entries] of res as any) {
                for (const [id, fields] of entries as any[]) {
                    const map = parseFields(fields as any);
                    const kind = map.kind as PresenceKind | undefined;
                    const entityId = map.id;
                    const ts = Number(map.ts);
                    const accountId = map.accountId || "";

                    if (!kind || !entityId || !Number.isFinite(ts)) {
                        pendingAckIds.push(id);
                        continue;
                    }

                    if (kind === "session") {
                        batcher.recordSessionAlive(entityId, ts);
                    } else if (kind === "machine" && accountId) {
                        batcher.recordMachineAlive(accountId, entityId, ts);
                    }

                    pendingAckIds.push(id);
                }
            }
        }
    });

    return { stop };
}
