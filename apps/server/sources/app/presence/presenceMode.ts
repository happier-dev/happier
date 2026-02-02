function isRedisAdapterEnabled(env: NodeJS.ProcessEnv): boolean {
    const flavor = (env.HAPPIER_SERVER_FLAVOR ?? env.HAPPY_SERVER_FLAVOR ?? '').trim();
    const adapter = (env.HAPPIER_SOCKET_REDIS_ADAPTER ?? env.HAPPY_SOCKET_REDIS_ADAPTER ?? '').toString().trim().toLowerCase();
    return (
        flavor !== 'light' &&
        (adapter === 'true' || adapter === '1') &&
        typeof env.REDIS_URL === 'string' &&
        env.REDIS_URL.trim().length > 0
    );
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
    const flavor = (env.HAPPIER_SERVER_FLAVOR ?? env.HAPPY_SERVER_FLAVOR ?? '').trim();
    if (flavor === 'light') return true;
    if (role === 'worker') return false;
    if (shouldPublishPresenceToRedis(env)) return false;
    // default: single-process full (SERVER_ROLE=all) or a full API process without Redis adapter enabled
    return true;
}
