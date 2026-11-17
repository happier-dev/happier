import { getRedisClient } from "@/storage/redis/redis";
import { backoff } from '@/utils/runtime/backoff';
import { shutdownSignal } from "@/utils/process/shutdown";
import { log } from "@/utils/logging/log";
import { schedulePresenceDeadline } from './timeout';
import { shouldPublishPresenceToRedis } from './presenceMode';
import { eventRouter } from '@/app/events/eventRouter';
import { PresenceDeadlineNotificationSchema, type PresenceDeadlineNotification } from './presenceDeadlineNotification';
import { readPresenceRedisWorkerConfigFromEnv, readPresenceStreamConfigFromEnv } from "@/config/presence";

const STREAM_KEY = "presence:alive:v1";

function getStreamMaxLen(env: NodeJS.ProcessEnv): number | null {
    return readPresenceStreamConfigFromEnv(env).streamMaxLen;
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

function parseFields(fields: Array<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) {
        out[fields[i]] = fields[i + 1];
    }
    return out;
}

/**
 * Follows the presence stream so this host enrolls every peer's deadline wake.
 * Current API nodes commit presence themselves and only write transition wakes
 * here; nothing on the stream needs SQL replay, so there is no consumer group
 * (0.2 API nodes cannot share a 0.3 database, so their queued beats never arrive).
 */
export function startPresenceRedisWorker(params?: {
    readCount?: number;
    onDeadline?: (observation: PresenceDeadlineNotification) => void;
}): { ready: Promise<void>; stop: () => Promise<void> } {
    const { readCount } = readPresenceRedisWorkerConfigFromEnv(process.env, params);
    // XREAD BLOCK 0 occupies its connection until an arrival; keep it off the shared client.
    const enrollmentRedis = getRedisClient().duplicate();
    const enrollmentAbort = new AbortController();
    let enrollCursor: string | null = null;
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const stopReaders = (): void => {
        enrollmentAbort.abort();
        enrollmentRedis.disconnect();
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

    const stop = async () => {
        stopReaders();
        await enrollment;
        shutdownSignal.removeEventListener('abort', stopReaders);
    };

    return { ready, stop };
}
