type RedisMemoryServerInstance = Readonly<{
    stop: () => Promise<boolean>;
    getIp: () => Promise<string>;
    getPort: () => Promise<number>;
}>;

type RedisMemoryServerModule = Readonly<{
    RedisMemoryServer: Readonly<{
        create: () => Promise<RedisMemoryServerInstance>;
    }>;
}>;

function buildMissingRedisMemoryServerError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
        `REDIS_URL is required when redis-memory-server is unavailable. Install the optional redis-memory-server dependency or set REDIS_URL explicitly. Original error: ${message}`,
    );
}

export async function resolveRedisAdapterValidationRedisUrl(params: {
    env: NodeJS.ProcessEnv;
    loadRedisMemoryServer?: () => Promise<RedisMemoryServerModule>;
}): Promise<{
    redisUrl: string;
    redisMemory: RedisMemoryServerInstance | null;
}> {
    const envRedisUrl = params.env.REDIS_URL?.trim() ?? '';
    if (envRedisUrl) {
        return {
            redisUrl: envRedisUrl,
            redisMemory: null,
        };
    }

    const loadRedisMemoryServer = params.loadRedisMemoryServer
        ?? (async () => await import('redis-memory-server'));

    let redisMemoryModule: RedisMemoryServerModule;
    try {
        redisMemoryModule = await loadRedisMemoryServer();
    } catch (error) {
        throw buildMissingRedisMemoryServerError(error);
    }

    const redisMemory = await redisMemoryModule.RedisMemoryServer.create();
    const ip = await redisMemory.getIp();
    const port = await redisMemory.getPort();

    return {
        redisUrl: `redis://${ip}:${port}`,
        redisMemory,
    };
}
