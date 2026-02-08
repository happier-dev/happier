export type ServerFlavor = "full" | "light";

export type FilesBackend = "local" | "s3";
export type SocketAdapter = "memory" | "redis-streams";

import { parseBooleanEnv } from "./env";

function normalizeToken(raw: string): string {
    return raw.trim().toLowerCase();
}

export function getFilesBackendFromEnv(env: NodeJS.ProcessEnv, fallback: FilesBackend): FilesBackend {
    const raw = (env.HAPPIER_FILES_BACKEND ?? env.HAPPY_FILES_BACKEND)?.toString();
    if (!raw) return fallback;
    const v = normalizeToken(raw);
    if (v === "local" || v === "disk" || v === "fs" || v === "file") return "local";
    if (v === "s3" || v === "minio") return "s3";
    return fallback;
}

export function getSocketAdapterFromEnv(env: NodeJS.ProcessEnv, fallback: SocketAdapter): SocketAdapter {
    const raw = (env.HAPPIER_SOCKET_ADAPTER ?? env.HAPPY_SOCKET_ADAPTER)?.toString();
    if (raw && raw.trim()) {
        const v = normalizeToken(raw);
        if (v === "memory" || v === "mem") return "memory";
        if (v === "redis-streams" || v === "redis" || v === "redis_streams") return "redis-streams";
        return fallback;
    }

    // Back-compat: historical boolean flag enabling redis-streams adapter.
    if (parseBooleanEnv(env.HAPPIER_SOCKET_REDIS_ADAPTER ?? env.HAPPY_SOCKET_REDIS_ADAPTER, false)) {
        return "redis-streams";
    }

    return fallback;
}

export function resolveDefaultFilesBackend(flavor: ServerFlavor): FilesBackend {
    return flavor === "light" ? "local" : "s3";
}

export function resolveDefaultSocketAdapter(_flavor: ServerFlavor): SocketAdapter {
    return "memory";
}

export function isRedisStreamsEnabled(env: NodeJS.ProcessEnv, adapter: SocketAdapter): boolean {
    if (adapter !== "redis-streams") return false;
    const url = env.REDIS_URL?.trim();
    return typeof url === "string" && url.length > 0;
}
