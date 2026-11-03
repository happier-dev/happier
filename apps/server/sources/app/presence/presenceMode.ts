import { getServerRoleFromEnv, getSocketAdapterFromEnv, isRedisStreamsEnabled } from "@/config/backends";

function isRedisAdapterEnabled(env: NodeJS.ProcessEnv): boolean {
    const socketAdapter = getSocketAdapterFromEnv(env, "memory");
    return isRedisStreamsEnabled(env, socketAdapter);
}

export function shouldPublishPresenceToRedis(env: NodeJS.ProcessEnv): boolean {
    const role = getServerRoleFromEnv(env);
    if (role === 'worker') return false;
    return isRedisAdapterEnabled(env);
}

export function shouldConsumePresenceFromRedis(env: NodeJS.ProcessEnv): boolean {
    const role = getServerRoleFromEnv(env);
    if (role === 'api') return false;
    return isRedisAdapterEnabled(env);
}
