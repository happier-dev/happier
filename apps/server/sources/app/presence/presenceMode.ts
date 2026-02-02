function isRedisAdapterEnabled(env: NodeJS.ProcessEnv): boolean {
    return (
        env.HAPPY_SERVER_FLAVOR !== 'light' &&
        (env.HAPPY_SOCKET_REDIS_ADAPTER === 'true' || env.HAPPY_SOCKET_REDIS_ADAPTER === '1') &&
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
    if (env.HAPPY_SERVER_FLAVOR === 'light') return true;
    if (role === 'worker') return false;
    if (shouldPublishPresenceToRedis(env)) return false;
    // default: single-process full (SERVER_ROLE=all) or a full API process without Redis adapter enabled
    return true;
}

