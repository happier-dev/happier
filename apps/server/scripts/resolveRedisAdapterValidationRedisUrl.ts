type RedisMemoryServerInstance = Readonly<{
    start: () => Promise<boolean>;
    stop: () => Promise<boolean>;
    getIp: () => Promise<string>;
    getPort: () => Promise<number>;
}>;

type RedisMemoryServerModule = Readonly<{
    RedisMemoryServer: Readonly<{
        create: (options: Readonly<{
            binary: Readonly<{
                version: string;
            }>;
        }>) => Promise<RedisMemoryServerInstance>;
    }>;
}>;

const REDIS_MEMORY_SERVER_VERSION = '7.2.4';

function buildMissingRedisMemoryServerError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
        `REDIS_URL is required when redis-memory-server is unavailable. Install the optional redis-memory-server dependency or set REDIS_URL explicitly. Original error: ${message}`,
    );
}

function buildRedisMemoryServerStartError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
        `REDIS_URL is required when embedded Redis ${REDIS_MEMORY_SERVER_VERSION} cannot start. Set REDIS_URL to a reachable Redis instance for Redis adapter validation. Original error: ${message}`,
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

    try {
        const redisMemory = await redisMemoryModule.RedisMemoryServer.create({
            binary: { version: REDIS_MEMORY_SERVER_VERSION },
        });
        const ip = await redisMemory.getIp();
        const port = await redisMemory.getPort();
        return {
            redisUrl: `redis://${ip}:${port}`,
            redisMemory,
        };
    } catch (error) {
        throw buildRedisMemoryServerStartError(error);
    }
}
