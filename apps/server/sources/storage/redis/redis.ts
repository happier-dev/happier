import { Redis } from "ioredis";

import { instrumentRedisClient } from "@/app/monitoring/metrics/instrumentRedisClient";
import { REDIS_SOCKET_STALL_TIMEOUT_MS, REDIS_SOCKET_STALE_TIMER_GRACE_MS } from "@/config/socketClusterRedis";
import { warn } from "@/utils/logging/log";

let _redis: Redis | null = null;
let _instrumentedRedis: Redis | null = null;
let _socketClusterRedis: Redis | null = null;
let _instrumentedSocketClusterRedis: Redis | null = null;
let _cleanupSocketClusterRedisDiagnostics: (() => void) | null = null;
let _socketClusterRedisUrl: string | null = null;
let _socketClusterAdapterRedis: Redis | null = null;
let _socketClusterAdapterDuplicateCount = 0;

const REDIS_SOCKET_ERROR_DIAGNOSTIC_INTERVAL_MS = 60_000;

type RedisSocketErrorClass = "connection" | "dns" | "timeout" | "unknown";

function classifyRedisSocketError(error: unknown): RedisSocketErrorClass {
    const code = typeof error === "object"
        && error !== null
        && "code" in error
        && typeof error.code === "string"
        ? error.code.toUpperCase()
        : "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
    if (
        code === "ECONNREFUSED"
        || code === "ECONNRESET"
        || code === "EPIPE"
        || code === "NR_CLOSED"
    ) {
        return "connection";
    }

    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("timeout") || message.includes("timed out")) return "timeout";
    if (message.includes("getaddrinfo") || message.includes("dns")) return "dns";
    return "unknown";
}

function isRedisSocketStallTimeout(error: unknown): boolean {
    return error instanceof Error
        && error.message.startsWith("Socket timeout. Expecting data, but didn't receive any in ");
}

function attachSocketClusterRedisDiagnostics(
    redis: Redis,
    connectionName: string,
    onSocketTimeout: () => void,
    onTransportConnect: () => void,
): () => void {
    let nextDiagnosticAt = 0;
    let suppressedSinceLastDiagnostic = 0;

    const onError = (error: unknown): void => {
        const errorClass = classifyRedisSocketError(error);
        if (isRedisSocketStallTimeout(error)) onSocketTimeout();
        const now = Date.now();
        if (now < nextDiagnosticAt) {
            suppressedSinceLastDiagnostic += 1;
            return;
        }
        warn(
            {
                module: "redis-socket-cluster",
                event: "client_error",
                connection: connectionName,
                errorClass,
                suppressedSinceLastDiagnostic,
            },
            "Socket.IO cluster Redis client error",
        );
        suppressedSinceLastDiagnostic = 0;
        nextDiagnosticAt = now + REDIS_SOCKET_ERROR_DIAGNOSTIC_INTERVAL_MS;
    };
    const onReady = (): void => {
        nextDiagnosticAt = 0;
        suppressedSinceLastDiagnostic = 0;
    };
    const cleanup = (): void => {
        redis.off("connect", onTransportConnect);
        redis.off("error", onError);
        redis.off("ready", onReady);
        redis.off("end", cleanup);
    };

    redis.on("connect", onTransportConnect);
    redis.on("error", onError);
    redis.on("ready", onReady);
    redis.on("end", cleanup);
    return cleanup;
}

function retrySocketClusterRedisConnection(
    attempt: number,
    transportConnected: boolean,
    socketTimeoutTriggered: boolean,
): number {
    if (transportConnected && !socketTimeoutTriggered) {
        // ioredis' socketTimeout timer belongs to the Redis client, not the
        // transport that armed it. A server-side close does not clear that
        // timer, so reconnecting sooner lets the stale callback destroy the
        // healthy replacement stream. Let the original timer expire first.
        return REDIS_SOCKET_STALL_TIMEOUT_MS + REDIS_SOCKET_STALE_TIMER_GRACE_MS;
    }
    return Math.min(attempt * 50, 2_000);
}

export function getRedisClient(): Redis {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
        throw new Error("REDIS_URL is not set");
    }
    if (!_redis) {
        _redis = new Redis(url);
        _instrumentedRedis = instrumentRedisClient(_redis) as Redis;
    }
    return _instrumentedRedis!;
}

/**
 * The socket-cluster transport owns more than one Redis connection: the root
 * publish/command client plus every connection the Socket.IO Redis Streams
 * adapter duplicates for itself (one blocking stream reader at
 * `streamCount = 1` and one Pub/Sub subscriber). Raw ioredis `duplicate()`
 * copies the same options object, so the duplicates would share one retry
 * closure and skip command instrumentation entirely.
 */
export type SocketClusterRedisConnectionKind = "root" | "adapter-duplicate" | "relay-admission";

const SOCKET_CLUSTER_REDIS_CONNECTION_NAME_PREFIX = "happier-socket-cluster";

export function buildSocketClusterRedisConnectionName(input: Readonly<{
    kind: SocketClusterRedisConnectionKind;
    diagnosticOrdinal?: number;
}>): string {
    if (input.kind === "root") return `${SOCKET_CLUSTER_REDIS_CONNECTION_NAME_PREFIX}:root`;
    if (input.kind === "relay-admission") {
        return `${SOCKET_CLUSTER_REDIS_CONNECTION_NAME_PREFIX}:relay-admission`;
    }
    return `${SOCKET_CLUSTER_REDIS_CONNECTION_NAME_PREFIX}:adapter-${input.diagnosticOrdinal ?? 0}`;
}

export type SocketClusterRedisConnection = Readonly<{
    connectionName: string;
    /** Instrumented client handed to consumers. */
    client: Redis;
    /** Underlying ioredis client, used only by whoever owns this lifecycle. */
    rawClient: Redis;
    detachDiagnostics: () => void;
}>;

/**
 * Construct one socket-cluster Redis connection with connection-local retry
 * state, classified/rate-limited diagnostics, command instrumentation, and a
 * diagnostic connection name that `CLIENT LIST` and tests can distinguish. The
 * name is diagnostic only; it never carries authority.
 */
export function createSocketClusterRedisConnection(input: Readonly<{
    kind: SocketClusterRedisConnectionKind;
    diagnosticOrdinal?: number;
    /** Adapter-owned clients must not reject an unawaited subscribe promise. */
    maxRetriesPerRequest?: number | null;
    /**
     * Explicit target, used so adapter duplicates always reach the same Redis
     * as the root instead of re-reading a possibly changed environment.
     */
    url?: string;
}>): SocketClusterRedisConnection {
    const url = input.url?.trim() || process.env.REDIS_URL?.trim();
    if (!url) {
        throw new Error("REDIS_URL is not set");
    }
    const connectionName = buildSocketClusterRedisConnectionName(input);
    const isRelayAdmission = input.kind === "relay-admission";
    let transportConnected = false;
    let socketTimeoutTriggered = false;
    const rawClient = new Redis(url, {
        connectionName,
        ...(isRelayAdmission
            ? { enableOfflineQueue: false, maxRetriesPerRequest: 0 }
            : input.maxRetriesPerRequest !== undefined
                ? { maxRetriesPerRequest: input.maxRetriesPerRequest }
                : {}),
        // The Socket.IO Redis Streams adapter continuously issues short blocking
        // reads. Bound its dedicated socket so a silent partition cannot strand
        // adapter routing behind that read. Relay admission has its own fail-closed
        // Redis connection and does not queue behind the adapter.
        socketTimeout: isRelayAdmission ? 2_000 : REDIS_SOCKET_STALL_TIMEOUT_MS,
        retryStrategy: (attempt) => {
            if (isRelayAdmission) return Math.min(attempt * 50, 2_000);
            const connected = transportConnected;
            const timeoutTriggered = socketTimeoutTriggered;
            transportConnected = false;
            socketTimeoutTriggered = false;
            return retrySocketClusterRedisConnection(attempt, connected, timeoutTriggered);
        },
    });
    const detachDiagnostics = attachSocketClusterRedisDiagnostics(
        rawClient,
        connectionName,
        () => {
            socketTimeoutTriggered = true;
        },
        () => {
            transportConnected = true;
        },
    );
    return {
        connectionName,
        client: instrumentRedisClient(rawClient) as Redis,
        rawClient,
        detachDiagnostics,
    };
}

/**
 * Build the fail-closed Redis connection used solely to reserve single-use
 * tunnel relay grants. The relay coordinator owns and closes every returned
 * client; this factory keeps no lifecycle registry.
 */
export function createRedisSocketClusterRelayAdmissionClient(): Redis {
    return createSocketClusterRedisConnection({ kind: "relay-admission" }).client;
}

export function getRedisSocketClusterClient(): Redis {
    if (!_socketClusterRedis) {
        const url = process.env.REDIS_URL?.trim();
        if (!url) {
            throw new Error("REDIS_URL is not set");
        }
        const connection = createSocketClusterRedisConnection({ kind: "root", url });
        _socketClusterRedis = connection.rawClient;
        _instrumentedSocketClusterRedis = connection.client;
        _cleanupSocketClusterRedisDiagnostics = connection.detachDiagnostics;
        _socketClusterRedisUrl = url;
    }
    return _instrumentedSocketClusterRedis!;
}

/**
 * Adapter-facing view of the same instrumented root client.
 *
 * Upstream `createAdapter()` accepts exactly one client and duplicates it
 * internally, so this narrow proxy overrides only `duplicate()` to build a
 * fresh, independently instrumented connection through the canonical factory.
 * Everything else forwards to the ordinary root that peer/tunnel coordination
 * also consumes.
 *
 * The adapter owns the lifecycle of the connections it requests: `io.close()`
 * disconnects them. This wrapper deliberately keeps no duplicate registry, so
 * there is no second closer competing with the adapter.
 */
export function getRedisSocketClusterAdapterClient(): Redis {
    const root = getRedisSocketClusterClient();
    if (!_socketClusterAdapterRedis) {
        const url = _socketClusterRedisUrl ?? undefined;
        const createAdapterDuplicate = (): Redis => {
            _socketClusterAdapterDuplicateCount += 1;
            return createSocketClusterRedisConnection({
                kind: "adapter-duplicate",
                diagnosticOrdinal: _socketClusterAdapterDuplicateCount,
                maxRetriesPerRequest: null,
                url,
            }).client;
        };
        _socketClusterAdapterRedis = new Proxy(root, {
            get(target, property) {
                if (property === "duplicate") return createAdapterDuplicate;
                const value = Reflect.get(target, property);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    const result = Reflect.apply(value, target, args);
                    // The upstream adapter intentionally drops some command
                    // promises (PUBLISH, XADD, and session SET) while it does
                    // await others. Keep every returned promise unchanged for
                    // callers that do await it, while marking an outage failure
                    // handled when the adapter drops it.
                    if (result && typeof (result as { then?: unknown }).then === "function") {
                        void Promise.resolve(result).catch(() => undefined);
                    }
                    return result;
                };
            },
        }) as Redis;
    }
    return _socketClusterAdapterRedis;
}

export function closeRedisSocketClusterClient(): void {
    const redis = _socketClusterRedis;
    const cleanupDiagnostics = _cleanupSocketClusterRedisDiagnostics;
    _socketClusterRedis = null;
    _instrumentedSocketClusterRedis = null;
    _cleanupSocketClusterRedisDiagnostics = null;
    // The wrapper is non-owning: clear it so a later start builds a fresh one,
    // but never disconnect adapter-owned duplicates here. `io.close()` already
    // aborted the reader and disconnected the subscriber before this runs.
    _socketClusterAdapterRedis = null;
    _socketClusterAdapterDuplicateCount = 0;
    _socketClusterRedisUrl = null;

    if (!redis) return;
    try {
        redis.disconnect(false);
    } finally {
        cleanupDiagnostics?.();
    }
}
