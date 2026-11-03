export type ServerFlavor = "full" | "light";

export type FilesBackend = "local" | "s3";
export type SocketAdapter = "memory" | "redis-streams";
export type ServerRole = 'all' | 'api' | 'worker';

export function getServerRoleFromEnv(env: NodeJS.ProcessEnv): ServerRole {
    const raw = env.SERVER_ROLE?.trim();
    return raw === 'api' || raw === 'worker' ? raw : 'all';
}

import { readServerConfig, readServerConfigRaw } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { getDbProviderFromEnv, resolveDefaultDbProvider } from './databaseProvider';

export function resolveServerFlavorFromEnv(env: NodeJS.ProcessEnv, fallback: ServerFlavor): ServerFlavor {
    const raw = readServerConfig(env, SERVER_CONFIG.HAPPIER_SERVER_FLAVOR)?.trim().toLowerCase();
    return raw === "light" || raw === "full" ? raw : fallback;
}

export function getFilesBackendFromEnv(env: NodeJS.ProcessEnv, fallback: FilesBackend): FilesBackend {
    return readServerConfig(env, SERVER_CONFIG.HAPPIER_FILES_BACKEND) ?? fallback;
}

export function getSocketAdapterFromEnv(env: NodeJS.ProcessEnv, fallback: SocketAdapter): SocketAdapter {
    const entry = SERVER_CONFIG.HAPPIER_SOCKET_ADAPTER;
    if (readServerConfigRaw(env, entry)) {
        // This caller supplies the flavor's fallback; a malformed explicit adapter cannot enable legacy Redis.
        return readServerConfig(env, { ...entry, default: fallback });
    }

    // Back-compat: historical boolean flag enabling redis-streams adapter.
    if (readServerConfig(env, SERVER_CONFIG.HAPPIER_SOCKET_REDIS_ADAPTER)) {
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

/** Startup needs local path defaults for either local files or an embedded database. */
export function shouldApplyLightDefaultEnv(env: NodeJS.ProcessEnv, flavor: ServerFlavor): boolean {
    const provider = getDbProviderFromEnv(env, resolveDefaultDbProvider(flavor));
    return getFilesBackendFromEnv(env, resolveDefaultFilesBackend(flavor)) === 'local'
        || provider === 'pglite' || provider === 'sqlite';
}

export function isRedisStreamsEnabled(env: NodeJS.ProcessEnv, adapter: SocketAdapter): boolean {
    if (adapter !== "redis-streams") return false;
    const url = env.REDIS_URL?.trim();
    return typeof url === "string" && url.length > 0;
}
