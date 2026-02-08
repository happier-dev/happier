import { getSocketAdapterFromEnv, isRedisStreamsEnabled } from "@/config/backends";

function isRedisAdapterEnabled(env: NodeJS.ProcessEnv): boolean {
    const socketAdapter = getSocketAdapterFromEnv(env, "memory");
    return isRedisStreamsEnabled(env, socketAdapter);
}

export function shouldPublishPresenceToRedis(env: NodeJS.ProcessEnv): boolean {
    const role = env.SERVER_ROLE?.trim();
    if (role !== 'api') return false;
    return isRedisAdapterEnabled(env);
}

export function shouldConsumePresenceFromRedis(env: NodeJS.ProcessEnv): boolean {
    const role = env.SERVER_ROLE?.trim();
    if (role !== 'worker') return false;
    return isRedisAdapterEnabled(env);
}

export function shouldEnableLocalPresenceDbFlush(env: NodeJS.ProcessEnv): boolean {
    const role = env.SERVER_ROLE?.trim();
    if (role === 'worker') return false;
    if (shouldPublishPresenceToRedis(env)) return false;
    // default: single-process full (SERVER_ROLE=all) or a full API process without Redis adapter enabled
    return true;
}
