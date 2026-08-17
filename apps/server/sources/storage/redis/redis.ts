import { Redis } from "ioredis";

import { instrumentRedisClient } from "@/app/monitoring/metrics/instrumentRedisClient";
import { warn } from "@/utils/logging/log";

let _redis: Redis | null = null;
let _instrumentedRedis: Redis | null = null;
let _socketClusterRedis: Redis | null = null;
let _instrumentedSocketClusterRedis: Redis | null = null;
let _cleanupSocketClusterRedisDiagnostics: (() => void) | null = null;

const REDIS_SOCKET_STALL_TIMEOUT_MS = 5_000;
const REDIS_SOCKET_STALE_TIMER_GRACE_MS = 50;
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

export function getRedisSocketClusterClient(): Redis {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
        throw new Error("REDIS_URL is not set");
    }
    if (!_socketClusterRedis) {
        let transportConnected = false;
        let socketTimeoutTriggered = false;
        _socketClusterRedis = new Redis(url, {
            // The Socket.IO Redis Streams adapter continuously issues short blocking
            // reads. Bound its dedicated socket so a silent partition cannot strand
            // adapter routing behind that read. Relay admission has its own fail-closed
            // Redis connection and does not queue behind the adapter.
            socketTimeout: REDIS_SOCKET_STALL_TIMEOUT_MS,
            retryStrategy: (attempt) => {
                const connected = transportConnected;
                const timeoutTriggered = socketTimeoutTriggered;
                transportConnected = false;
                socketTimeoutTriggered = false;
                return retrySocketClusterRedisConnection(attempt, connected, timeoutTriggered);
            },
        });
        _cleanupSocketClusterRedisDiagnostics = attachSocketClusterRedisDiagnostics(
            _socketClusterRedis,
            () => {
                socketTimeoutTriggered = true;
            },
            () => {
                transportConnected = true;
            },
        );
        _instrumentedSocketClusterRedis = instrumentRedisClient(_socketClusterRedis) as Redis;
    }
    return _instrumentedSocketClusterRedis!;
}

export function closeRedisSocketClusterClient(): void {
    const redis = _socketClusterRedis;
    const cleanupDiagnostics = _cleanupSocketClusterRedisDiagnostics;
    _socketClusterRedis = null;
    _instrumentedSocketClusterRedis = null;
    _cleanupSocketClusterRedisDiagnostics = null;

    if (!redis) return;
    try {
        redis.disconnect(false);
    } finally {
        cleanupDiagnostics?.();
    }
}
