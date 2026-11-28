import { Redis } from "ioredis";

type RedisCommandDelivery = "default" | "fail-on-disconnect";
const clients: Partial<Record<RedisCommandDelivery, Redis>> = {};

export function getRedisClient(delivery: RedisCommandDelivery = "default"): Redis {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
        throw new Error("REDIS_URL is not set");
    }
    return clients[delivery] ??= new Redis(url, delivery === "fail-on-disconnect" ? { maxRetriesPerRequest: 0 } : {});
}
