import { getRedisClient } from "@/storage/redis/redis";
import { PresenceBatcher } from "./presenceBatcher";
import { db } from "@/storage/db";
import { forever } from "@/utils/runtime/forever";
import { backoff } from '@/utils/runtime/backoff';
import { AbortedExeption } from '@/utils/runtime/aborted';
import { delay } from "@/utils/runtime/delay";
import { shutdownSignal } from "@/utils/process/shutdown";
import { log } from "@/utils/logging/log";
import { randomUUID } from "node:crypto";
import { recordMachineAliveInTx } from './presenceRecorder';
import { afterTx, inTx } from '@/storage/inTx';
import { schedulePresenceDeadline } from './timeout';
import { shouldPublishPresenceToRedis } from './presenceMode';
import { eventRouter } from '@/app/events/eventRouter';
import { PresenceDeadlineNotificationSchema, type PresenceDeadlineNotification } from './presenceDeadlineNotification';
import { readPresenceRedisWorkerConfigFromEnv, readPresenceStreamConfigFromEnv } from "@/config/presence";
import { resolveCurrentMachineRecipientAccountIdsInTx } from '@/app/machines/machineAccess';
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

export async function publishMachineAlive(params: { accountId: string; machineId: string; timestamp: number }): Promise<void> {
    await publishAlive({ kind: 'machine', accountId: params.accountId, id: params.machineId, activeAt: params.timestamp });
}

async function publishAlive(observation: PresenceDeadlineNotification): Promise<void> {
    const redis = getRedisClient();
    const maxLen = getStreamMaxLen(process.env);
    const maxLenArgs = maxLen ? (["MAXLEN", "~", String(maxLen)] as const) : ([] as const);
    await redis.xadd(
        STREAM_KEY,
        ...maxLenArgs,
        "*",
        "kind",
        observation.kind,
        "id",
        observation.id,
        "ts",
        observation.activeAt.toString(),
        "accountId",
        observation.accountId,
    );
}

/** A transition wake, not a second liveness write or heartbeat broadcaster. */
export async function publishPresenceDeadline(observation: PresenceDeadlineNotification): Promise<void> {
    try {
        eventRouter.broadcastPresenceDeadline(observation);
        if (shouldPublishPresenceToRedis(process.env)) await publishAlive(observation);
    }
    catch (error) { log({ module: 'presence-deadline', error }, 'Failed to publish presence deadline wake'); }
}

async function ensureGroupExists(): Promise<void> {
    const redis = getRedisClient();
    try {
        // MKSTREAM creates the stream if it does not exist.
        await redis.xgroup("CREATE", STREAM_KEY, GROUP, "0", "MKSTREAM");
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
    const failures: unknown[] = [];

    if (machines.length > 0) {
        await runWithConcurrencyLimit(
            machines,
            dbWriteConcurrency,
            async (machinePresence) => {
                try {
                    // Released API nodes queue admitted observations here. New
                    // API nodes already committed; neither path owns expiry.
                    await inTx(tx => recordMachineAliveInTx(tx, machinePresence, async (_, machine) => {
                        if (machine.accountId !== machinePresence.accountId
                            || machine.revokedAt || machine.replacedByMachineId) return null;
                        if (machine.active) {
                            afterTx(tx, () => schedulePresenceDeadline({ kind: 'machine', accountId: machine.accountId,
                                id: machinePresence.machineId, activeAt: machine.lastActiveAt.getTime() }));
                        }
                        return {
                            recipientAccountIds: machine.active ? []
                                : await resolveCurrentMachineRecipientAccountIdsInTx(tx, machinePresence.machineId),
                            wasOffline: !machine.active, lastActiveAt: machine.lastActiveAt,
                        };
                    }));
                } catch (error) {
                    failures.push(error);
                    log(
                        { module: "presence-redis-worker", level: "warn" },
                        `Machine presence update failed: ${error}`,
                    );
                }
            },
        );
    }

    for (const presence of sessions) {
        try {
            const session = await db.session.findUnique({ where: { id: presence.sessionId },
                select: { accountId: true, active: true, archivedAt: true, lastActiveAt: true } });
            if (session?.active && session.archivedAt === null && session.accountId === presence.accountId) {
                schedulePresenceDeadline({ kind: 'session', accountId: session.accountId,
                    id: presence.sessionId, activeAt: session.lastActiveAt.getTime() });
            }
        } catch (error) { failures.push(error); }
    }

    if (failures.length > 0) throw failures[0];
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
    onDeadline?: (observation: PresenceDeadlineNotification) => void;
}): { ready: Promise<void>; stop: () => Promise<void> } {
    const { dbWriteConcurrency, flushIntervalMs, readBlockMs, readCount, reclaimIdleMs } =
        readPresenceRedisWorkerConfigFromEnv(process.env, params);

    const redis = getRedisClient();
    const batcher = new PresenceBatcher();
    let flushTimer: NodeJS.Timeout | null = null;
    const consumerName = params?.consumerName ?? getConsumerName(process.env);
    const pendingAckIds: string[] = [];
    let lastReclaimAt = 0;
    let stopped = false;
    let flushInFlight = Promise.resolve();
    // The consumer group distributes legacy SQL work; it cannot broadcast
    // enrollment. Each deadline host follows the SAME stream independently,
    // without a consumer group, socket server, peer identity, or extra key.
    const enrollmentRedis = redis.duplicate();
    // BLOCK occupies a Redis connection until an arrival or the read deadline.
    // Keep socket ownership checks and all other commands off that connection.
    const streamRedis = redis.duplicate();
    const enrollmentAbort = new AbortController();
    let enrollCursor: string | null = null;
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const stopReaders = (): void => {
        enrollmentAbort.abort();
        enrollmentRedis.disconnect();
        streamRedis.disconnect();
        markReady();
    };
    shutdownSignal.addEventListener('abort', stopReaders, { once: true });
    const enrollment = backoff(async () => {
        if (enrollCursor === null) {
            const tail = await enrollmentRedis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', 1);
            enrollCursor = tail[0]?.[0] ?? '0-0';
            // Startup captures the stream cursor BEFORE its persisted census.
            // Activations before the cursor are seeded; later ones are read.
            markReady();
        }
        while (!enrollmentAbort.signal.aborted) {
            const cursor: string = enrollCursor;
            const reply = await enrollmentRedis.xread('COUNT', readCount, 'BLOCK', 0,
                'STREAMS', STREAM_KEY, cursor);
            for (const [, entries] of reply ?? []) {
                for (const [id, fields] of entries) {
                    const value = parseFields(fields);
                    const parsed = PresenceDeadlineNotificationSchema.safeParse({ kind: value.kind,
                        accountId: value.accountId, id: value.id, activeAt: Number(value.ts) });
                    if (parsed.success && !enrollmentAbort.signal.aborted) {
                        (params?.onDeadline ?? schedulePresenceDeadline)(parsed.data);
                    }
                    enrollCursor = id;
                }
            }
        }
    }, enrollmentAbort.signal).catch(error => {
        if (!enrollmentAbort.signal.aborted) log({ module: 'presence-deadline', error }, 'Enrollment reader failed');
    });

    const clearTimer = () => {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
    };

    const flushPending = () => {
        const flush = flushInFlight.catch(() => {}).then(async () => {
            // Capture ACK custody with the batch, before persistence can yield to later arrivals.
            const ids = pendingAckIds.slice();
            if (ids.length === 0) return;
            await flushBatch(batcher, dbWriteConcurrency);
            await redis.xack(STREAM_KEY, GROUP, ...ids);
            pendingAckIds.splice(0, ids.length);
            recordPresenceStreamAck(ids.length);
            setPresenceStreamPendingEntries(pendingAckIds.length);
            await refreshRedisPendingEntries(redis);
        });
        flushInFlight = flush;
        return flush;
    };

    const startTimer = () => {
        if (stopped || flushTimer || pendingAckIds.length === 0) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            void flushPending()
                .catch((e) => {
                    log({ module: "presence-redis-worker", level: "error" }, `Error flushing presence batch: ${e}`);
                })
                .finally(() => {
                    if (pendingAckIds.length === 0) clearTimer();
                    // Failed pending work keeps the existing flush cadence; an empty queue parks.
                    startTimer();
                });
        }, flushIntervalMs);
        flushTimer.unref?.();
    };

    const recordPendingEntry = (id: string) => {
        pendingAckIds.push(id);
        setPresenceStreamPendingEntries(pendingAckIds.length);
        startTimer();
    };

    const stop = async () => {
        stopped = true;
        stopReaders();
        clearTimer();
        await flushPending();
        await enrollment;
        shutdownSignal.removeEventListener('abort', stopReaders);
        setPresenceStreamPendingEntries(pendingAckIds.length);
        await refreshRedisPendingEntries(redis);
    };

    void forever("presence-redis-worker", async () => {
        if (stopped) throw new AbortedExeption();
        await ensureGroupExists();

        while (!shutdownSignal.aborted && !stopped) {
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
                            recordPendingEntry(id);
                            continue;
                        }

                        if (kind === "session" && accountId) {
                            batcher.recordSessionAlive(accountId, entityId, ts);
                        } else if (kind === "machine" && accountId) {
                            batcher.recordMachineAlive(accountId, entityId, ts);
                        }

                        recordPendingEntry(id);
                    }
                    // Reclaimed observations already spent their transport
                    // grace in the PEL. Do not add another five-second batch.
                    if (entries.length > 0) {
                        await flushPending();
                        if (pendingAckIds.length === 0) clearTimer();
                    }
                    await refreshRedisPendingEntries(redis);
                } catch (e) {
                    // Best-effort: do not kill the worker if reclaim fails.
                    log({ module: "presence-redis-worker", level: "warn" }, `Presence reclaim failed: ${e}`);
                }
            }

            const res = await streamRedis.xreadgroup(
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
            ).catch(error => {
                if (stopped || shutdownSignal.aborted) throw new AbortedExeption();
                throw error;
            });

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
                        recordPendingEntry(id);
                        continue;
                    }

                    if (kind === "session" && accountId) {
                        batcher.recordSessionAlive(accountId, entityId, ts);
                    } else if (kind === "machine" && accountId) {
                        batcher.recordMachineAlive(accountId, entityId, ts);
                    }

                    recordPendingEntry(id);
                }
            }
            recordPresenceStreamRead("stream", readEntryCount);
            await refreshRedisPendingEntries(redis);
        }
        throw new AbortedExeption();
    });

    return { ready, stop };
}
