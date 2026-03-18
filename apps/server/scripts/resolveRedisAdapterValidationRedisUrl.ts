export type RedisAdapterValidationRedisUrlResolution = {
    redisUrl: string;
    stop: () => Promise<void>;
};

type RedisMemoryServerLike = {
    getIp: () => Promise<string>;
    getPort: () => Promise<number>;
    stop: () => Promise<boolean>;
};

export async function resolveRedisAdapterValidationRedisUrl(
    env: NodeJS.ProcessEnv = process.env,
): Promise<RedisAdapterValidationRedisUrlResolution> {
    const redisUrl = env.REDIS_URL?.trim();
    if (redisUrl) {
        return {
            redisUrl,
            stop: async () => {},
        };
    }

    let redisMemory: RedisMemoryServerLike | null = null;
    try {
        const { RedisMemoryServer } = await import('redis-memory-server');
        redisMemory = (await RedisMemoryServer.create()) as RedisMemoryServerLike;
    } catch (error) {
        throw new Error(
            `validate:redis-adapter requires REDIS_URL or redis-memory-server: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const ip = await redisMemory.getIp();
    const port = await redisMemory.getPort();

    return {
        redisUrl: `redis://${ip}:${port}`,
        stop: async () => {
            await redisMemory?.stop().catch(() => {});
        },
    };
}
