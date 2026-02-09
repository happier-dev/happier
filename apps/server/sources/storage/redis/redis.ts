import { Redis } from "ioredis";

let _redis: Redis | null = null;

export function getRedisClient(): Redis {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
        throw new Error("REDIS_URL is not set");
    }
    if (!_redis) {
        _redis = new Redis(url);
    }
    return _redis;
}
