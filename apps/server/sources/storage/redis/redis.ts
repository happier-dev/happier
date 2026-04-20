import { Redis } from "ioredis";

import { instrumentRedisClient } from "@/app/monitoring/metrics/instrumentRedisClient";

let _redis: Redis | null = null;
let _instrumentedRedis: Redis | null = null;

export function getRedisClient(): Redis {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
        throw new Error("REDIS_URL is not set");
    }
    if (!_redis) {
        _redis = new Redis(url);
        _instrumentedRedis = instrumentRedisClient(_redis) as Redis;
    }
    return _instrumentedRedis!;
}
